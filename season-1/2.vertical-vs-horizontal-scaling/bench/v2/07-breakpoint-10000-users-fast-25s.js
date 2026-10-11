import http from "k6/http";
import { pickUrl, reqParams } from "./pick-live.js";

export const options = {
  scenarios: {
    monster: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "5s", target: 3000 }, // warmup
        { duration: "5s", target: 5000 }, // tera last max
        { duration: "5s", target: 7500 }, // yaha se CPU royega
        { duration: "5s", target: 10000 }, // yaha pe tootega
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<1000"], // marks the run failed, does not stop it
  },
};

export function setup() {
  return { url: pickUrl() };
}

export default function (data) {
  http.get(data.url, reqParams);
}
