// 钩子/后台测试里的命令是 POSIX 语法（echo '…' / true），统一显式走 bash：
// Git Bash（Windows 打包环境）与 Linux 均可解析；不设则 Windows 默认落到 cmd.exe 会全部失败
process.env.BAJIN_SHELL ??= 'bash';
