# v0.1.29

## 优化宠物语音开口与连续播放

- 长回复先合成短首段，优先按自然标点或词边界切分；短回复保持完整，后续段仍限制长度，减少文字已显示后等待整段语音的时间。
- 播放当前段时最多预生成下一段，不预取全文、不开并行 GPU 合成；下一段就绪后按顺序播放，减少段间等待。
- 停止、隐藏、退出及新朗读同时清理播放段与预生成段，拒绝迟到音频；原生续段校验防止旧朗读在跨窗口停止事件迟到时抢占新的试听。
- 增加匿名分阶段计时，可区分服务准备、桥接合成、编码、解码、首次播放与段间等待；不记录朗读文字或音频，不新增上传。

## 使用与验证边界

- 交互权限请求仍需明确选择“允许一次/拒绝”；显示宠物、播放语音或打开输入框均不代表授权。
- 本版仍返回完整分段 WAV，不是端到端音频流式输出；未更换模型、参考音色或 GPU 推理参数。首声改善程度、分段语气与衔接须在实际 Windows/GPU 环境确认，不承诺固定毫秒数。
- 本地前端 917 项、Rust 跨平台库 404 项通过，类型检查和前端生产构建通过；Windows 专属构建与测试由发布流水线执行，不能替代 GPU 与声卡实机试听。
- 更新不会自动升级或重启 WSL 中的 Harness，不会自动开启语音或记忆扩展。提供 NSIS 安装包、独立 EXE、Tauri 更新签名、latest.json 和 SHA256SUMS.txt；更新签名不等于 Windows Authenticode 代码签名，SmartScreen 仍可能提示。

## 上游来源与许可

Pet code/animations: https://github.com/PC2005-cloud/dsh-pet (PC2005-cloud). Code MIT; animation assets prohibit commercial use. Derivative introductions, displays and distributions must retain this original-author URL.

本项目第一方代码为 MIT；第三方动画素材不适用本项目 MIT 授权。模型权重与运行时仍受各自许可证约束。
