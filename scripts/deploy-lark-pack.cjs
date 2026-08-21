// Deploy the lark skill pack: copy PACK.md into ~/.puck/skills/lark/ and
// create a junction per lark-* skill in ~/.claude/skills (single source of
// truth — Claude Code keeps its flat view, puck gains the two-tier view).
// Idempotent; junctions to nonexistent targets are recreated.
// Run: node scripts/deploy-lark-pack.cjs [--dry]
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const os = require("node:os");

const DRY = process.argv.includes("--dry");
const HOME = os.homedir();
const CLAUDE_SKILLS = path.join(HOME, ".claude", "skills");
const PACK_DIR = path.join(HOME, ".puck", "skills", "lark");
const PACK_MD_SRC = path.join(__dirname, "lark-pack", "PACK.md");

function log(action, target) {
	console.log(`${DRY ? "[dry] " : ""}${action}: ${target}`);
}

if (!fs.existsSync(PACK_MD_SRC)) {
	console.error(`missing ${PACK_MD_SRC}`);
	process.exit(1);
}

// 1. PACK.md
fs.mkdirSync(PACK_DIR, { recursive: true });
log("write", path.join(PACK_DIR, "PACK.md"));
if (!DRY) fs.copyFileSync(PACK_MD_SRC, path.join(PACK_DIR, "PACK.md"));

// 2. junction per lark-* skill in ~/.claude/skills
const larkDirs = fs
	.readdirSync(CLAUDE_SKILLS)
	.filter((d) => /^lark[a-z0-9-]*$/.test(d))
	.filter((d) => fs.statSync(path.join(CLAUDE_SKILLS, d)).isDirectory());

let created = 0;
let kept = 0;
for (const name of larkDirs) {
	const linkPath = path.join(PACK_DIR, name);
	const target = path.join(CLAUDE_SKILLS, name);
	if (fs.existsSync(linkPath)) {
		kept++;
		continue;
	}
	log("junction", `${linkPath} -> ${target}`);
	if (!DRY) {
		try {
			fs.symlinkSync(target, linkPath, "junction");
			created++;
		} catch (e) {
			console.error(`failed: ${name}: ${e.message}`);
			process.exit(1);
		}
	} else {
		created++;
	}
}
console.log(`\nlark-* found in ~/.claude/skills: ${larkDirs.length}; junctions created: ${created}, already present: ${kept}`);
if (larkDirs.length !== 25) console.log(`note: expected 25, found ${larkDirs.length} — PACK.md 清单请核对`);
