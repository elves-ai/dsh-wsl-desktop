; Included by Tauri before its MUI pages. Keep all install/update logic upstream.
; These definitions style both the interactive installer and uninstaller.
SetFont "Microsoft YaHei UI" 9

!define MUI_TEXTCOLOR "17243B"
!define MUI_BGCOLOR "FFFFFF"
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP_STRETCH AspectFitHeight
!define MUI_HEADERIMAGE_UNBITMAP_STRETCH AspectFitHeight
!define MUI_WELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight
!define MUI_UNWELCOMEFINISHPAGE_BITMAP_STRETCH AspectFitHeight

!define MUI_WELCOMEPAGE_TITLE "欢迎安装$\r$\nDSH WSL Desktop"
!define MUI_WELCOMEPAGE_TEXT "在 Windows 桌面使用 DeepSeek Harness。$\r$\n$\r$\n本向导仅安装桌面启动器，不会安装或升级 WSL 中的 DSH，也不会更改现有项目与会话。$\r$\n$\r$\n使用前，请确认已配置好 WSL、DSH 及原有启动器。$\r$\n$\r$\n点击“下一步”继续。"
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "DSH WSL Desktop 已安装到你的电脑。$\r$\n$\r$\n启动后会尝试导入旧启动器配置，并连接 WSL 中的 DSH 服务。没有旧配置时，请参照项目说明完成配置。$\r$\n$\r$\n点击“完成”关闭向导。"
!define MUI_FINISHPAGE_RUN_TEXT "启动 DSH WSL Desktop"
