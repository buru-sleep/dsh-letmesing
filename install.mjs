#!/usr/bin/env node
/**
 * 把 LetMeSing 装进你的 DeepSeek Harness profile。
 *
 * 做三件事：
 *   1. 在 <profile>/package.json 的 dependencies 里加一条 link: 指向这个目录
 *   2. 在 dsh.profile.bundles 里登记，让 Loader 启动时加载它
 *   3. 在 <profile>/node_modules 里建软链接
 *
 * 不碰 cordis.patch.yml，也不用 pnpm —— 装歪了删掉这两处就能恢复。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "dsh-letmesing";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const profilesRoot = path.join(os.homedir(), ".dsh", "profiles");

if (!fs.existsSync(profilesRoot)) {
  console.error("✗ 找不到 ~/.dsh/profiles");
  console.error("  先把 DeepSeek Harness 桌面端启动一次，让它建好 profile 目录，再来跑这个脚本。");
  process.exit(1);
}

const wanted = process.argv[2];
const found = fs
  .readdirSync(profilesRoot)
  .filter((d) => fs.existsSync(path.join(profilesRoot, d, "package.json")))
  .filter((d) => (wanted ? d === wanted : true));

if (!found.length) {
  console.error(wanted ? `✗ 没有名为 ${wanted} 的 profile` : "✗ 一个 profile 都没找到");
  process.exit(1);
}

const linkTarget = repo.replace(/\\/g, "/");

for (const profile of found) {
  const dir = path.join(profilesRoot, profile);
  const pkgPath = path.join(dir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

  pkg.dependencies ??= {};
  pkg.dependencies[NAME] = `link:${linkTarget}`;

  pkg.dsh ??= {};
  pkg.dsh.profile ??= {};
  pkg.dsh.profile.bundles ??= [];
  if (!pkg.dsh.profile.bundles.includes(NAME)) {
    pkg.dsh.profile.bundles.push(NAME);
  }

  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const linkPath = path.join(dir, "node_modules", NAME);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.rmSync(linkPath, { recursive: true, force: true });
  fs.symlinkSync(repo, linkPath, "junction");

  console.log(`✓ ${profile}`);
}

console.log("");
console.log("装好了。重启 DeepSeek Harness，设置里会多出 LetMeSing 这一栏。");
console.log("要卸载：把 package.json 里那两处 dsh-letmesing 删掉，再删 node_modules 里的软链接。");
