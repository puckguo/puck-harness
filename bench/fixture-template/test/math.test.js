import { add } from "../src/math.js";

// T3 baseline: TWO failing cases (see bench/tasks/t3.md)
console.log(add(2, 3) === 5 ? "ok" : "FAIL 2+3");
console.log(add(-1, 1) === 0 ? "ok" : "FAIL -1+1");
console.log(add(0.1, 0.2) === 0.3 ? "ok" : "FAIL 0.1+0.2");
console.log(add(10, -4) === 6 ? "ok" : "FAIL 10-4");
