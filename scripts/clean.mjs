import { rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

for (const entry of readdirSync("packages")) {
	rmSync(join("packages", entry, "dist"), { recursive: true, force: true });
	rmSync(join("packages", entry, "tsconfig.tsbuildinfo"), { recursive: true, force: true });
}
rmSync("tsconfig.tsbuildinfo", { force: true });
console.log("cleaned");
