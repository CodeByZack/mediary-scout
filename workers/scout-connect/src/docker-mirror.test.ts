import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Docker Hub 镜像源支持的护栏。
 *
 * 背景:本项目主要面向中国大陆用户,而 **Docker Hub 在大陆经常不可达**
 * (`failed to fetch anonymous token: ... EOF` / `connection reset by peer`)。
 * 作者实测:重试十余次全失败,换公共镜像站一次成功。
 *
 * 三个 Docker Hub 镜像(postgres / node / cloudflared)必须都能被同一个
 * DOCKER_MIRROR 变量改写。**漏掉任何一个,用户的表现是「拉了两个成功、
 * 第三个卡住」,而报错发生在流程末尾(最费时间),很难联想到是同一个原因。**
 */
describe("DOCKER_MIRROR 覆盖全部 Docker Hub 镜像", () => {
  const root = new URL("../../../", import.meta.url);
  const compose = readFileSync(new URL("docker-compose.yml", root), "utf8");
  const dockerfile = readFileSync(new URL("Dockerfile", root), "utf8");
  const envExample = readFileSync(new URL(".env.example", root), "utf8");
  const connectSh = readFileSync(new URL("assets/connect.sh", import.meta.url.replace(/src\/[^/]+$/, "")), "utf8");

  it("compose 里的 postgres 与 cloudflared 都走变量", () => {
    for (const img of ["postgres:16-alpine", "cloudflare/cloudflared:latest"]) {
      const line = compose.split("\n").find((l) => l.includes(`image:`) && l.includes(img));
      expect(line, `没找到 ${img} 的 image 行`).toBeDefined();
      expect(line, `${img} 没有走 DOCKER_MIRROR —— 墙内用户会卡在这个镜像`).toContain(
        "DOCKER_MIRROR",
      );
    }
  });

  it("Dockerfile 的 node 基础镜像走变量,且**两个阶段都声明了 ARG**", () => {
    // ARG 的作用域到 FROM 处结束。runner 阶段漏声明会让变量展开成空串 →
    // 那一层悄悄回落 Docker Hub,于是 builder 成功、runner 卡住。
    const froms = dockerfile.split("\n").filter((l) => l.startsWith("FROM "));
    expect(froms.length).toBeGreaterThanOrEqual(2);
    for (const f of froms) expect(f).toContain("DOCKER_MIRROR");
    expect(dockerfile.match(/^ARG DOCKER_MIRROR$/gm)?.length).toBe(froms.length);
  });

  it("compose 自动把 DOCKER_MIRROR 传进 build args", () => {
    // 不传的话用户还得记得手敲 --build-arg,漏了就只有 build 阶段失败。
    expect(compose).toMatch(/DOCKER_MIRROR:\s*\$\{DOCKER_MIRROR:-\}/);
  });

  it("默认值为空 —— 境外用户零影响", () => {
    // ${VAR:+...} 语法:非空才加前缀。默认必须展开成官方镜像名。
    expect(compose).toContain("${DOCKER_MIRROR:+");
    expect(dockerfile).toContain("${DOCKER_MIRROR:+");
    expect(envExample).toMatch(/^DOCKER_MIRROR=$/m);
  });

  it("pansou 不受影响(它走 ghcr.io,墙内通常可直连)", () => {
    const line = compose.split("\n").find((l) => l.includes("pansou-web"));
    expect(line).toContain("ghcr.io");
    expect(line).not.toContain("DOCKER_MIRROR");
  });

  it("connect.sh 能识别真实的 Docker Hub 报错并给出解法", () => {
    // 这三条是作者今晚实际遇到的原始报错。
    expect(connectSh).toContain("DOCKER_MIRROR");
    for (const pat of ["fetch anonymous token", "connection reset by peer", "resolve reference"]) {
      expect(connectSh, `诊断分支漏了 ${pat}`).toContain(pat);
    }
    // 必须点出「旧版 compose 不支持这个变量」——否则用户照做却毫无变化。
    expect(connectSh).toContain("旧版本");
  });

  it("**生成产物 assets.gen.ts 与源文件同步**(我今晚漏过这一步)", () => {
    // /connect.sh 路由读的是 RAW_ASSETS(assets.gen.ts),**不是** assets/connect.sh。
    // 改了源文件不跑 `node scripts/generate-content.mjs`,线上拿到的还是旧脚本 ——
    // 而 tsc 和所有测试都是绿的,部署也"成功",只有 curl 线上才能发现。
    // 我今晚就是这么漏的:改完 connect.sh、提交、部署、自检通过,
    // 然后 curl 线上发现新内容一个字都没有。
    const gen = readFileSync(new URL("html/assets.gen.ts", import.meta.url), "utf8");
    for (const pat of ["DOCKER_MIRROR", "fetch anonymous token", "旧版本"]) {
      expect(gen, `assets.gen.ts 缺 ${pat} —— 忘了跑 generate-content.mjs?`).toContain(pat);
    }
  });

  it(".env.example 与文档都列出多个镜像站", () => {
    // 公共镜像站会轮流失效。只给一个 = 那个站挂了用户就卡死。
    const deploy = readFileSync(new URL("docs/deploy.md", root), "utf8");
    for (const doc of [envExample, deploy]) {
      const hits = ["docker.1ms.run", "dockerproxy.net", "docker.m.daocloud.io", "hub.rat.dev"]
        .filter((m) => doc.includes(m));
      expect(hits.length).toBeGreaterThanOrEqual(4);
    }
  });
});
