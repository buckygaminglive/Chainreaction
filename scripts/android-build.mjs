/**
 * Builds the native Android app in one step.
 *
 *   npm run android:debug     installable test APK (debug-signed)
 *   npm run android:bundle    Play Store upload (.aab), signed with your upload
 *                             key if keystore.properties exists
 *   npm run android:apk       release APK, same signing rule
 *
 * Each run rebuilds the web game, copies it into the Android project
 * (`cap sync`), then runs Gradle — so the APK always carries the current code.
 *
 * Finding Java: JAVA_HOME if set, otherwise the JDK that ships inside Android
 * Studio. Gradle 9.5 runs on it (Java 25); 9.6 does not work with the Android
 * Gradle Plugin 8.x this project uses, so the wrapper is pinned to 9.5.0.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = join(ROOT, 'android');
const isWin = platform() === 'win32';

const TASKS = {
  debug: { task: 'assembleDebug', out: 'app/build/outputs/apk/debug/app-debug.apk' },
  bundle: { task: 'bundleRelease', out: 'app/build/outputs/bundle/release/app-release.aab' },
  apk: { task: 'assembleRelease', out: 'app/build/outputs/apk/release' },
};

const kind = process.argv[2] ?? 'debug';
const job = TASKS[kind];
if (!job) {
  console.error(`Unknown build "${kind}". Use one of: ${Object.keys(TASKS).join(', ')}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function findJava() {
  if (process.env.JAVA_HOME && existsSync(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  const candidates = isWin
    ? ['C:\\Program Files\\Android\\Android Studio\\jbr']
    : ['/Applications/Android Studio.app/Contents/jbr/Contents/Home', '/opt/android-studio/jbr', join(homedir(), 'android-studio', 'jbr')];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** An SDK with the platform the project compiles against, written to
 *  android/local.properties if that file is missing. */
function ensureSdk() {
  const props = join(ANDROID, 'local.properties');
  if (existsSync(props)) return;
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    isWin ? join(homedir(), 'AppData', 'Local', 'Android', 'Sdk') : join(homedir(), 'Library', 'Android', 'sdk'),
    join(homedir(), 'Android', 'Sdk'),
    join(homedir(), '.bubblewrap', 'android_sdk'),
  ].filter(Boolean);
  const hasPlatform = (sdk) => {
    try {
      return readdirSync(join(sdk, 'platforms')).some((p) => p.startsWith('android-36'));
    } catch {
      return false;
    }
  };
  const sdk = candidates.find(hasPlatform) ?? candidates.find((c) => existsSync(c));
  if (!sdk) {
    console.error('No Android SDK found. Install Android Studio, or set ANDROID_HOME.');
    process.exit(1);
  }
  writeFileSync(props, `sdk.dir=${sdk.replace(/\\/g, '/')}\n`);
  console.log(`Using Android SDK at ${sdk}`);
}

const java = findJava();
if (!java) {
  console.error('No JDK found. Install Android Studio, or set JAVA_HOME to a JDK 21+.');
  process.exit(1);
}

if (kind !== 'debug' && !existsSync(join(ROOT, 'keystore.properties'))) {
  console.warn(
    '\n  keystore.properties not found — this release build will be UNSIGNED and Play will reject it.\n' +
      '  Copy keystore.properties.example to keystore.properties and fill in your upload key passwords.\n'
  );
}

run('npm', ['run', 'build'], { cwd: ROOT });
run('npx', ['cap', 'sync', 'android'], { cwd: ROOT });
ensureSdk();
// Absolute and quoted: cmd.exe will not reliably find a bare `gradlew.bat` in
// the working directory, and this path has spaces in it.
const gradlew = isWin ? `"${join(ANDROID, 'gradlew.bat')}"` : './gradlew';
run(gradlew, [job.task, '--console=plain'], {
  cwd: ANDROID,
  env: { ...process.env, JAVA_HOME: java },
});

console.log(`\nBuilt: android/${job.out}`);
