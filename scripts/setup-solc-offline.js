/**
 * Offline solc setup.
 *
 * Hardhat normally downloads the Solidity compiler from
 * https://binaries.soliditylang.org on first compile. On networks that block
 * that host (corporate proxies, college firewalls, sandboxes) every compile
 * fails with "HH502: Couldn't download compiler version list".
 *
 * The compiler is also published to npm as the `solc` package, which is a
 * devDependency of this project. This script copies that copy into Hardhat's
 * global compiler cache so `npx hardhat compile` works with no network at all.
 *
 *   node scripts/setup-solc-offline.js
 *
 * It is idempotent, and safe to re-run after `npx hardhat clean --global`.
 * If your network is unrestricted you never need it.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const SOLC_VERSION = "0.8.24";

// Mirror of Hardhat's own CompilerPlatform enum.
function nativePlatform() {
  switch (os.platform()) {
    case "win32":
      return "windows-amd64";
    case "linux":
      return "linux-amd64";
    case "darwin":
      return "macosx-amd64";
    default:
      return "wasm";
  }
}

// Mirror of Hardhat's getCompilersDir(): <globalCache>/compilers-v2
function compilersDir() {
  const home = os.homedir();
  let cache;
  if (os.platform() === "win32") {
    cache = path.join(
      process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
      "hardhat-nodejs",
      "Cache"
    );
  } else if (os.platform() === "darwin") {
    cache = path.join(home, "Library", "Caches", "hardhat-nodejs");
  } else {
    cache = path.join(
      process.env.XDG_CACHE_HOME || path.join(home, ".cache"),
      "hardhat-nodejs"
    );
  }
  return path.join(cache, "compilers-v2");
}

function main() {
  // Resolve the soljson bundle shipped inside the npm `solc` package.
  const solc = require("solc");
  const longVersion = solc.version(); // e.g. 0.8.24+commit.e11b9ed9.Emscripten.clang
  const version = longVersion.split("+")[0];

  if (version !== SOLC_VERSION) {
    console.error(
      `Expected solc ${SOLC_VERSION} but the installed package is ${version}.\n` +
        `Run:  npm i -D solc@${SOLC_VERSION}`
    );
    process.exit(1);
  }

  const soljsonSrc = require.resolve("solc/soljson.js");
  // Hardhat names the cached file after the build, minus the toolchain suffix.
  const shortLong = longVersion.replace(/\.Emscripten\.clang$/, "");
  const wasmFileName = `solc-v${shortLong}.js`;

  const root = compilersDir();
  const wasmDir = path.join(root, "wasm");
  fs.mkdirSync(wasmDir, { recursive: true });

  // 1. Put the compiler itself in the WASM slot.
  const wasmTarget = path.join(wasmDir, wasmFileName);
  fs.copyFileSync(soljsonSrc, wasmTarget);

  // 2. Write the minimal build list Hardhat looks up the version in.
  //    keccak256 is only checked right after a real download, which we skip,
  //    so an empty digest here is never read.
  const buildList = (platform, buildPath) => ({
    builds: [
      {
        path: buildPath,
        version,
        build: shortLong.split("+")[1],
        longVersion: shortLong,
        keccak256: "0x",
        urls: [],
        platform,
      },
    ],
    releases: { [version]: buildPath },
    latestRelease: version,
  });

  fs.writeFileSync(
    path.join(wasmDir, "list.json"),
    JSON.stringify(buildList("wasm", wasmFileName), null, 2)
  );

  // 3. Hardhat tries the *native* compiler before falling back to WASM, and
  //    throws if it cannot even fetch the native list. So satisfy that lookup
  //    too, then flag the native binary as broken with the ".does.not.work"
  //    marker Hardhat itself uses. It then quietly falls back to our WASM copy.
  const platform = nativePlatform();
  if (platform !== "wasm") {
    const nativeDir = path.join(root, platform);
    fs.mkdirSync(nativeDir, { recursive: true });

    const nativeName =
      platform === "windows-amd64"
        ? `solc-${platform}-v${shortLong}.exe`
        : `solc-${platform}-v${shortLong}`;
    const nativeTarget = path.join(nativeDir, nativeName);

    if (!fs.existsSync(nativeTarget)) fs.writeFileSync(nativeTarget, "");
    fs.writeFileSync(`${nativeTarget}.does.not.work`, "");
    fs.writeFileSync(
      path.join(nativeDir, "list.json"),
      JSON.stringify(buildList(platform, nativeName), null, 2)
    );
  }

  console.log(`solc ${longVersion} installed into Hardhat's cache:`);
  console.log(`  ${wasmTarget}`);
  console.log("`npx hardhat compile` now works offline.");
}

main();
