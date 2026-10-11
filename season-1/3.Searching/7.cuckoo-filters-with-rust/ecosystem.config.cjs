// 4 processes, one port (cluster mode). They all map the same data/cuckoo.bin, so the filter is in RAM once.
module.exports = {
  apps: [{ name: 'cuckoo-rust', script: 'src/server.js', instances: 4, exec_mode: 'cluster', node_args: '--env-file-if-exists=.env' }],
};
