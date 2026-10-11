// Cuckoo filter in a memory-mapped file, shared by every PM2 process on the machine.
//
// One file = one physical copy of the table in RAM (the OS page cache), however many processes map it.
//   readers  : lock free, a seqlock (header word SEQ) tells them when a writer was moving fingerprints around
//   writers  : one at a time, a process Mutex plus flock on `<file>.writer.lock` (flock = across processes)
//   rebuild  : builds `<file>.tmp<pid>` from Mongo, replays the Redis Stream lines written meanwhile, renames it over the
//              real file and marks the old one RETIRED. Every process notices that flag and re-maps the new file.
//   build.lock (`<file>.build.lock`): only one process builds at a time, so 4 PM2 workers starting together build once.
//
// Fingerprints are 32 bit, buckets hold 4, the bucket count is any number (not a power of 2):
//   i1 = hash_hi mod N,  i2 = (H(fp) mod N - i1) mod N.  Applying it twice gives i1 back, so a kicked fingerprint finds its way home.
use fs2::FileExt;
use memmap2::MmapMut;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{fence, AtomicU32, AtomicU64, Ordering::*};
use std::sync::{Arc, Mutex, RwLock};
use xxhash_rust::xxh3::xxh3_64;

const SLOTS: usize = 4;
const MAX_KICKS: usize = 500;
const HDR: usize = 4096;
const MAGIC: u64 = 0x4355_4B4F_4F46_5231; // "CUKOOFR1"
const VERSION: u64 = 1;

// header words (each a u64 at word index * 8)
const W_MAGIC: usize = 0;
const W_VERSION: usize = 1;
const W_BUCKETS: usize = 2;
const W_COUNT: usize = 3;
const W_STATE: usize = 4; // 0 = being built, 1 = ready
const W_RETIRED: usize = 5; // 1 = a newer file replaced this one, re-map
const W_FULL: usize = 6; // 1 = an insert ran out of kicks, `has` answers "maybe" for everything
const W_SEQ: usize = 7; // seqlock: odd while a writer is moving fingerprints
const W_GEN: usize = 8;
const W_VFP: usize = 9; // the fingerprint that did not fit
const W_VI: usize = 10; // and the bucket it was in

fn err(e: impl std::fmt::Display) -> Error {
    Error::from_reason(e.to_string())
}

fn buckets_for(items: u64) -> u64 {
    ((items as f64 / SLOTS as f64 / 0.9).ceil() as u64).max(2) // aim for ~90% full
}

// ---------------------------------------------------------------- the mapped table

struct Mapping {
    _mmap: MmapMut,
    hdr: *const AtomicU64,
    tab: *const AtomicU32,
    n: u64,
}
unsafe impl Send for Mapping {}
unsafe impl Sync for Mapping {}

impl Mapping {
    fn wrap(mut mmap: MmapMut, n: u64) -> Self {
        let base = mmap.as_mut_ptr();
        Mapping { hdr: base as *const AtomicU64, tab: unsafe { base.add(HDR) } as *const AtomicU32, _mmap: mmap, n }
    }

    // a brand new, empty file (state 0 until the builder says it is done)
    fn create(path: &Path, n: u64, gen: u64) -> std::io::Result<Self> {
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(true).open(path)?;
        file.set_len((HDR + n as usize * SLOTS * 4) as u64)?;
        let m = Self::wrap(unsafe { MmapMut::map_mut(&file)? }, n);
        m.h(W_MAGIC).store(MAGIC, Relaxed);
        m.h(W_VERSION).store(VERSION, Relaxed);
        m.h(W_BUCKETS).store(n, Relaxed);
        m.h(W_GEN).store(gen, Relaxed);
        Ok(m)
    }

    fn open(path: &Path) -> std::result::Result<Self, String> {
        let file = OpenOptions::new().read(true).write(true).open(path).map_err(|e| e.to_string())?;
        let len = file.metadata().map_err(|e| e.to_string())?.len() as usize;
        if len < HDR {
            return Err("file too small".into());
        }
        let m = Self::wrap(unsafe { MmapMut::map_mut(&file) }.map_err(|e| e.to_string())?, 0);
        if m.h(W_MAGIC).load(Relaxed) != MAGIC || m.h(W_VERSION).load(Relaxed) != VERSION {
            return Err("not a cuckoo file".into());
        }
        let n = m.h(W_BUCKETS).load(Relaxed);
        if m.h(W_STATE).load(Relaxed) != 1 || m.h(W_SEQ).load(Relaxed) & 1 == 1 || HDR + n as usize * SLOTS * 4 != len {
            return Err("file was not finished (crash while building or writing)".into());
        }
        Ok(Mapping { n, ..m })
    }

    #[inline]
    fn h(&self, w: usize) -> &AtomicU64 {
        unsafe { &*self.hdr.add(w) }
    }
    #[inline]
    fn slot(&self, i: u64, s: usize) -> &AtomicU32 {
        unsafe { &*self.tab.add(i as usize * SLOTS + s) }
    }
    #[inline]
    fn alt(&self, i: u64, fp: u32) -> u64 {
        let hf = fp.wrapping_mul(0x5bd1_e995) as u64 % self.n;
        (hf + self.n - i) % self.n
    }
    #[inline]
    fn locate(&self, s: &str) -> (u32, u64, u64) {
        let h = xxh3_64(s.as_bytes());
        let fp = (h as u32).max(1); // 0 means empty slot
        let i1 = (h >> 32) % self.n;
        (fp, i1, self.alt(i1, fp))
    }
    #[inline]
    fn find(&self, i: u64, fp: u32) -> bool {
        (0..SLOTS).any(|s| self.slot(i, s).load(Relaxed) == fp)
    }
    fn put(&self, i: u64, fp: u32) -> bool {
        for s in 0..SLOTS {
            if self.slot(i, s).load(Relaxed) == 0 {
                self.slot(i, s).store(fp, Relaxed);
                return true;
            }
        }
        false
    }
    fn retired(&self) -> bool {
        self.h(W_RETIRED).load(Relaxed) != 0
    }

    // Lock free. A "found" is always trusted. A "not found" only counts if no writer moved anything meanwhile.
    fn has(&self, s: &str) -> bool {
        if self.h(W_FULL).load(Relaxed) != 0 {
            return true; // full: say "maybe" and let the DB decide
        }
        let (fp, i1, i2) = self.locate(s);
        for _ in 0..200 {
            let s1 = self.h(W_SEQ).load(Acquire);
            if s1 & 1 == 0 {
                if self.find(i1, fp) || self.find(i2, fp) {
                    return true;
                }
                fence(Acquire);
                if self.h(W_SEQ).load(Relaxed) == s1 {
                    return false;
                }
            }
            std::hint::spin_loop();
        }
        true // a writer would not let go: "maybe" is the safe answer
    }

    // Caller holds the writer lock. false = filter is full (the item is kept in the victim stash).
    fn add(&self, s: &str, rng: &mut u64) -> bool {
        if self.h(W_FULL).load(Relaxed) != 0 {
            return false;
        }
        let (mut fp, i1, i2) = self.locate(s);
        self.h(W_COUNT).fetch_add(1, Relaxed);
        if self.put(i1, fp) || self.put(i2, fp) {
            return true; // a single store, nothing moved, readers need no seqlock
        }
        let seq = self.h(W_SEQ);
        let s0 = seq.load(Relaxed);
        seq.store(s0 + 1, Relaxed);
        fence(Release);
        let mut i = if next(rng) & 1 == 0 { i1 } else { i2 };
        let mut ok = false;
        for _ in 0..MAX_KICKS {
            let slot = self.slot(i, (next(rng) % SLOTS as u64) as usize);
            fp = slot.swap(fp, Relaxed); // kick a random resident out
            i = self.alt(i, fp); // its only other home
            if self.put(i, fp) {
                ok = true;
                break;
            }
        }
        if !ok {
            self.h(W_VFP).store(fp as u64, Relaxed);
            self.h(W_VI).store(i, Relaxed);
            self.h(W_FULL).store(1, Relaxed);
        }
        seq.store(s0 + 2, Release);
        ok
    }

    // Caller holds the writer lock. Only call for names that were really added.
    fn delete(&self, s: &str) -> bool {
        let (fp, i1, i2) = self.locate(s);
        for i in [i1, i2] {
            for sl in 0..SLOTS {
                if self.slot(i, sl).load(Relaxed) == fp {
                    self.slot(i, sl).store(0, Relaxed);
                    self.h(W_COUNT).fetch_sub(1, Relaxed);
                    if self.h(W_FULL).load(Relaxed) != 0 {
                        let (vfp, vi) = (self.h(W_VFP).load(Relaxed) as u32, self.h(W_VI).load(Relaxed));
                        if self.put(vi, vfp) || self.put(self.alt(vi, vfp), vfp) {
                            self.h(W_FULL).store(0, Release); // freed a slot, took the victim back
                        }
                    }
                    return true;
                }
            }
        }
        false
    }
}

fn next(rng: &mut u64) -> u64 {
    *rng ^= *rng << 13;
    *rng ^= *rng >> 7;
    *rng ^= *rng << 17;
    *rng
}

// ---------------------------------------------------------------- the shared object

struct Cfg {
    path: PathBuf,
    expected: u64,
    mongo_uri: String,
    db: String,
    coll: String,
    redis_url: String,
    stream: String,
}

struct Writer {
    lock: File,
    rng: u64,
}

struct Inner {
    cfg: Cfg,
    map: RwLock<Option<Mapping>>,
    writer: Mutex<Writer>,
    build_lock: File,
}

fn side_file(path: &Path, ext: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(ext);
    PathBuf::from(s)
}

fn lock_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path)
}

impl Inner {
    // Re-map when a rebuild replaced the file under us.
    fn remap_if_retired(&self) -> Result<()> {
        if !self.map.read().unwrap().as_ref().is_some_and(|m| m.retired()) {
            return Ok(());
        }
        let mut g = self.map.write().unwrap();
        if g.as_ref().is_some_and(|m| m.retired()) {
            *g = Some(Mapping::open(&self.cfg.path).map_err(err)?);
        }
        Ok(())
    }

    fn read<R>(&self, f: impl Fn(&Mapping) -> R) -> Result<R> {
        loop {
            {
                let g = self.map.read().unwrap();
                let m = g.as_ref().ok_or_else(|| err("filter not initialised, await filter.init() first"))?;
                if !m.retired() {
                    return Ok(f(m));
                }
            }
            self.remap_if_retired()?;
        }
    }

    fn write<R>(&self, f: impl FnOnce(&Mapping, &mut u64) -> R) -> Result<R> {
        let mut w = self.writer.lock().unwrap();
        w.lock.lock_exclusive().map_err(err)?;
        let out = (|| {
            self.remap_if_retired()?;
            let g = self.map.read().unwrap();
            let m = g.as_ref().ok_or_else(|| err("filter not initialised, await filter.init() first"))?;
            Ok(f(m, &mut w.rng))
        })();
        let _ = w.lock.unlock();
        out
    }

    fn init_blocking(&self) -> Result<()> {
        if self.try_open() {
            return Ok(());
        }
        self.build_lock.lock_exclusive().map_err(err)?;
        let out = if self.try_open() { Ok(()) } else { self.build_locked().map(|_| ()) }; // another worker may have built it while we waited
        let _ = self.build_lock.unlock();
        out
    }

    fn try_open(&self) -> bool {
        match Mapping::open(&self.cfg.path) {
            Ok(m) if !m.retired() && m.n >= buckets_for(self.cfg.expected) => {
                println!("cuckoo: mapped {} ({} items, {} buckets, generation {})", self.cfg.path.display(), m.h(W_COUNT).load(Relaxed), m.n, m.h(W_GEN).load(Relaxed));
                *self.map.write().unwrap() = Some(m);
                true
            }
            _ => false,
        }
    }

    fn rebuild_blocking(&self) -> Result<f64> {
        self.build_lock.lock_exclusive().map_err(err)?;
        let out = self.build_locked();
        let _ = self.build_lock.unlock();
        out
    }

    // Caller holds build.lock. Writers are NOT blocked while Mongo is read, only for the final replay + rename.
    fn build_locked(&self) -> Result<f64> {
        let c = &self.cfg;
        let start_id = self.stream_last_id(); // note the position first, then read Mongo: nothing in between is lost
        let mongo = if c.mongo_uri.is_empty() {
            None
        } else {
            Some(mongodb::sync::Client::with_uri_str(&c.mongo_uri).map_err(err)?.database(&c.db).collection::<mongodb::bson::Document>(&c.coll))
        };
        let in_db = match &mongo {
            Some(coll) => coll.estimated_document_count().run().map_err(err)?,
            None => 0,
        };
        let n = buckets_for(c.expected.max((in_db as f64 * 1.1) as u64)); // never smaller than the data
        let old_gen = Mapping::open(&c.path).map(|m| m.h(W_GEN).load(Relaxed)).unwrap_or(0);
        let tmp_path = side_file(&c.path, &format!(".tmp{}", std::process::id()));
        let tmp = Mapping::create(&tmp_path, n, old_gen + 1).map_err(err)?;
        let mut rng = 0x9E37_79B9_7F4A_7C15u64;
        let t = std::time::Instant::now();
        let mut count = 0u64;
        if let Some(coll) = &mongo {
            let cursor = coll.find(mongodb::bson::doc! {}).projection(mongodb::bson::doc! { "username": 1, "_id": 0 }).batch_size(10_000).run().map_err(err)?;
            for doc in cursor {
                if let Ok(u) = doc.map_err(err)?.get_str("username") {
                    tmp.add(u, &mut rng);
                    count += 1;
                }
            }
        }
        // the short, locked part: replay what changed meanwhile, rename, retire the old file
        let w = self.writer.lock().unwrap();
        w.lock.lock_exclusive().map_err(err)?;
        let swapped = (|| -> Result<()> {
            self.stream_replay(&start_id, &tmp, &mut rng);
            tmp.h(W_STATE).store(1, Relaxed);
            tmp._mmap.flush().map_err(err)?;
            let old = Mapping::open(&c.path).ok();
            std::fs::rename(&tmp_path, &c.path).map_err(err)?;
            if let Some(o) = old {
                o.h(W_RETIRED).store(1, Release); // every process holding the old file re-maps on its next call
            }
            *self.map.write().unwrap() = Some(Mapping::open(&c.path).map_err(err)?);
            Ok(())
        })();
        let _ = w.lock.unlock();
        swapped?;
        println!("cuckoo: built {} items from Mongo in {:.1}s, {} buckets, load {:.2}", count, t.elapsed().as_secs_f64(), n, tmp.h(W_COUNT).load(Relaxed) as f64 / (n * SLOTS as u64) as f64);
        Ok(count as f64)
    }

    // ---- Redis Stream: only used while rebuilding. Redis down = skip, the rebuild still finishes.
    fn redis(&self) -> Option<redis::Connection> {
        if self.cfg.redis_url.is_empty() {
            return None;
        }
        let c = redis::Client::open(self.cfg.redis_url.as_str()).ok()?.get_connection_with_timeout(std::time::Duration::from_secs(2)).ok()?;
        c.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok()?;
        Some(c)
    }

    fn stream_last_id(&self) -> String {
        let Some(mut con) = self.redis() else { return "0-0".into() };
        redis::cmd("XREVRANGE")
            .arg(&self.cfg.stream)
            .arg("+")
            .arg("-")
            .arg("COUNT")
            .arg(1)
            .query::<redis::streams::StreamRangeReply>(&mut con)
            .ok()
            .and_then(|r| r.ids.into_iter().next().map(|i| i.id))
            .unwrap_or_else(|| "0-0".into())
    }

    // A name added twice is harmless (a delete then leaves one stale copy, the DB still answers right). A missed add is not.
    fn stream_replay(&self, after: &str, tmp: &Mapping, rng: &mut u64) {
        let Some(mut con) = self.redis() else { return };
        let mut from = format!("({after}");
        loop {
            let Ok(r) = redis::cmd("XRANGE").arg(&self.cfg.stream).arg(&from).arg("+").arg("COUNT").arg(1000).query::<redis::streams::StreamRangeReply>(&mut con) else { return };
            let Some(last) = r.ids.last().map(|i| i.id.clone()) else { return };
            for e in &r.ids {
                let (Some(op), Some(u)) = (e.get::<String>("op"), e.get::<String>("username")) else { continue };
                if op == "add" {
                    tmp.add(&u, rng);
                } else if op == "del" && tmp.has(&u) {
                    tmp.delete(&u);
                }
            }
            from = format!("({last}");
        }
    }
}

// ---------------------------------------------------------------- what Node sees

#[napi(object)]
pub struct Options {
    pub path: String,
    pub expected_items: f64,
    pub mongo_uri: Option<String>, // empty = start with an empty filter (tests)
    pub db_name: Option<String>,
    pub collection: Option<String>,
    pub redis_url: Option<String>,
    pub stream: Option<String>,
}

#[napi(object)]
pub struct FilterStats {
    pub items: f64,
    pub buckets: f64,
    pub fingerprint_bits: u32,
    pub size_bytes: f64,
    pub load_factor: f64,
    pub full: bool,
    pub generation: f64,
    pub expected_false_positive_rate: f64,
    pub path: String,
}

#[napi]
pub struct Filter {
    inner: Arc<Inner>,
}

pub struct InitTask(Arc<Inner>);
pub struct RebuildTask(Arc<Inner>);

impl Task for InitTask {
    type Output = ();
    type JsValue = ();
    fn compute(&mut self) -> Result<()> {
        self.0.init_blocking()
    }
    fn resolve(&mut self, _: Env, _: ()) -> Result<()> {
        Ok(())
    }
}

impl Task for RebuildTask {
    type Output = f64;
    type JsValue = f64;
    fn compute(&mut self) -> Result<f64> {
        self.0.rebuild_blocking()
    }
    fn resolve(&mut self, _: Env, n: f64) -> Result<f64> {
        Ok(n)
    }
}

#[napi]
impl Filter {
    #[napi(constructor)]
    pub fn new(o: Options) -> Result<Self> {
        let path = PathBuf::from(&o.path);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        let cfg = Cfg {
            expected: o.expected_items as u64,
            mongo_uri: o.mongo_uri.unwrap_or_default(),
            db: o.db_name.unwrap_or_default(),
            coll: o.collection.unwrap_or_else(|| "usernames".into()),
            redis_url: o.redis_url.unwrap_or_default(),
            stream: o.stream.unwrap_or_else(|| "usernames:changes".into()),
            path,
        };
        let writer = Writer { lock: lock_file(&side_file(&cfg.path, ".writer.lock")).map_err(err)?, rng: 0x9E37_79B9_7F4A_7C15 ^ ((std::process::id() as u64) << 8) | 1 };
        let build_lock = lock_file(&side_file(&cfg.path, ".build.lock")).map_err(err)?;
        Ok(Filter { inner: Arc::new(Inner { cfg, map: RwLock::new(None), writer: Mutex::new(writer), build_lock }) })
    }

    /// Maps the file, or builds it from Mongo when it is missing, unfinished or too small. Await it once at startup.
    #[napi]
    pub fn init(&self) -> AsyncTask<InitTask> {
        AsyncTask::new(InitTask(self.inner.clone()))
    }

    /// Re-reads Mongo into a new file and swaps it in. Resolves with the number of names. Readers are never blocked.
    #[napi]
    pub fn rebuild(&self) -> AsyncTask<RebuildTask> {
        AsyncTask::new(RebuildTask(self.inner.clone()))
    }

    #[napi]
    pub fn has(&self, name: String) -> Result<bool> {
        self.inner.read(|m| m.has(&name))
    }

    /// One call for many names: the Node to Rust crossing is the slow part, so batch when you can.
    #[napi]
    pub fn has_many(&self, names: Vec<String>) -> Result<Vec<bool>> {
        self.inner.read(|m| names.iter().map(|n| m.has(n)).collect())
    }

    /// false means the filter is full (the name is still remembered, `has` now answers "maybe" for everything).
    #[napi]
    pub fn add(&self, name: String) -> Result<bool> {
        self.inner.write(|m, rng| m.add(&name, rng))
    }

    #[napi]
    pub fn add_many(&self, names: Vec<String>) -> Result<u32> {
        self.inner.write(|m, rng| names.iter().filter(|n| m.add(n, rng)).count() as u32)
    }

    /// Only call for names that were really added.
    #[napi]
    pub fn delete(&self, name: String) -> Result<bool> {
        self.inner.write(|m, _| m.delete(&name))
    }

    #[napi]
    pub fn stats(&self) -> Result<FilterStats> {
        let path = self.inner.cfg.path.display().to_string();
        self.inner.read(|m| {
            let items = m.h(W_COUNT).load(Relaxed) as f64;
            let load = items / (m.n * SLOTS as u64) as f64;
            FilterStats {
                items,
                buckets: m.n as f64,
                fingerprint_bits: 32,
                size_bytes: (m.n as usize * SLOTS * 4) as f64,
                load_factor: load,
                full: m.h(W_FULL).load(Relaxed) != 0,
                generation: m.h(W_GEN).load(Relaxed) as f64,
                expected_false_positive_rate: 2.0 * SLOTS as f64 * load / 2f64.powi(32),
                path: path.clone(),
            }
        })
    }
}
