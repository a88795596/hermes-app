import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const mobile = join(root, "apps/mobile");
process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: mobile, encoding: "utf8", stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit", maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new Error(`无法运行 ${command}（${result.error.code}），请检查本机工具链。`);
  if (result.status !== 0) throw new Error(`${command} 失败（退出码 ${result.status}），流程已停止。`);
  return result.stdout?.trim();
}

function selectDevice(devices, requested) {
  const selected = requested ? devices.filter(device => device.id === requested || device.identifier === requested) : devices;
  if (selected.length !== 1) {
    throw new Error(`请连接、解锁并信任一台真机，或用 --device 指定设备标识。可用设备：${devices.map(device => `${device.id} ${device.name ?? ""}`).join("、") || "无"}`);
  }
  return selected[0].id;
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    device: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  const [platform] = positionals;
  if (values.help) {
    console.log("本地编译、安装并启动 Release App：\npnpm app:android [--device Android序列号]\npnpm app:ios [--device iPhone的UDID]\n仅一台可用真机时自动选择；iOS 使用本机 Xcode 和现有 Ad Hoc 签名凭据。");
  } else {
    if (positionals.length !== 1 || !["android", "ios"].includes(platform)) throw new Error("请使用 pnpm app:android 或 pnpm app:ios。");
    for (const file of [".env.local", ".env"]) {
      if (existsSync(join(mobile, file))) process.loadEnvFile(join(mobile, file));
    }
    if (!process.env.EXPO_PUBLIC_HOT_UPDATER_BASE_URL || !process.env.EXPO_PUBLIC_HOT_UPDATER_API_KEY) {
      throw new Error("请先在 apps/mobile/.env.local 配置热更新地址和客户端 API Key。");
    }
    const { expo } = JSON.parse(readFileSync(join(mobile, "app.json"), "utf8"));

    if (platform === "android") {
      const devices = run("adb", ["devices", "-l"], true).split("\n").slice(1)
        .map(line => line.trim().split(/\s+/)).filter(([id, state]) => state === "device" && !id.startsWith("emulator-"))
        .map(([id]) => ({ id }));
      const device = selectDevice(devices, values.device);
      if (!process.env.JAVA_HOME && process.platform === "darwin") process.env.JAVA_HOME = run("/usr/libexec/java_home", ["-v", "17"], true);
      run("pnpm", ["exec", "expo", "prebuild", "--platform", "android", "--no-install"]);
      run("pnpm", ["exec", "expo", "run:android", "--variant", "release", "--device", device, "--no-bundler"]);
      // Expo 的开发链接可能打开系统选择器，Release 安装后显式冷启动主 Activity。
      const launch = run("adb", ["-s", device, "shell", "am", "start", "-W", "-S", "-n", `${expo.android.package}/.MainActivity`], true);
      if (!/^Status: ok$/m.test(launch)) throw new Error("Android App 启动失败，请检查设备状态。");
    } else {
      const { result } = JSON.parse(run("xcrun", ["devicectl", "list", "devices", "--json-output", "-", "--quiet"], true));
      const devices = result.devices.flatMap(device => {
        const hardware = device.properties?.hardware ?? device.hardwareProperties;
        const state = device.properties?.connection?.state ?? device.connectionProperties?.tunnelState;
        return hardware?.reality === "physical" && hardware.platform === "iOS" && ["connected", "disconnected"].includes(state)
          ? [{ id: hardware.udid, identifier: device.identifier, name: device.properties?.state?.name ?? device.deviceProperties?.name }] : [];
      });
      const device = selectDevice(devices, values.device);
      // EAS 在临时目录预构建，先把新原生指纹保留在当前工作区供后续 OTA 使用。
      run("pnpm", ["exec", "hot-updater", "fingerprint", "create"]);
      const builds = join(root, ".data/builds");
      mkdirSync(builds, { recursive: true });
      const output = mkdtempSync(join(builds, "ios-"));
      const ipa = join(output, "Hermes.ipa");
      const pnpm = run("which", ["pnpm"], true);
      // 保持 Node 和 Homebrew CocoaPods 优先，并直接调用本地构建插件。
      process.env.PATH = [dirname(process.execPath), ...["/opt/homebrew/bin", "/opt/homebrew/opt/ruby/bin"].filter(existsSync), process.env.PATH].join(":");
      process.env.EAS_LOCAL_BUILD_PLUGIN_PATH = "eas-cli-local-build-plugin";
      process.env.npm_config_registry = "https://registry.npmjs.org";
      run(pnpm, ["--package=eas-cli@27.10.0", "--package=eas-cli-local-build-plugin@27.10.0", "dlx", "eas",
        "build", "--local", "--platform", "ios", "--profile", "preview", "--non-interactive", "--freeze-credentials", "--output", ipa]);
      if (!existsSync(ipa)) throw new Error("本地构建未生成 IPA，未执行设备安装。");
      run("ditto", ["-x", "-k", ipa, output]);
      const apps = readdirSync(join(output, "Payload")).filter(name => name.endsWith(".app"));
      if (apps.length !== 1) throw new Error("IPA 中未找到唯一的 App，未执行设备安装。");
      const app = join(output, "Payload", apps[0]);
      run("codesign", ["--verify", "--deep", "--strict", app]);
      run("xcrun", ["devicectl", "device", "install", "app", "--device", device, app]);
      run("xcrun", ["devicectl", "device", "process", "launch", "--device", device, "--terminate-existing", expo.ios.bundleIdentifier]);
      console.log(`IPA 已保存：${ipa}`);
    }
    console.log("本地 Release 编译、安装和启动完成。");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
