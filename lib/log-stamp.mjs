// log-stamp.mjs — 统一日志时间戳（**side-effect 模块**）
//
// 为什么单独成文件：ESM 的 import 会被提升并按顺序求值 ⇒ 只要把它放在 **第一个 import**，
// 它的副作用（给 console.* 加前缀）就会在其它模块的**顶层代码**之前生效。
// 于是 daemon.log 里除了 bootstrap / runtime 子进程那几行（早于本模块），每条都带 `[MM-DD HH:MM:SS]`。
//
// 前缀格式与 headless-daemon.sh 的 log() 一致（本地时区）。

const stamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `[${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
};

for (const level of ["error", "warn", "log", "info", "debug"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => orig(stamp(), ...args);
}
