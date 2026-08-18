// e2e 起的 app-server 子进程会继承本进程环境；钩子测试里的命令是 POSIX 语法（echo '…' / exit 2），
// 统一显式走 bash：Git Bash（Windows）与 Linux 均可解析；不设则 Windows 默认落到 cmd.exe 会解析错 JSON
process.env.BAJIN_SHELL ??= 'bash';
