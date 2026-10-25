//! Strict lexical conversion for the single configured WSL distribution. No filesystem or process access.
fn distribution_valid(distribution: &str) -> bool {
    distribution.len() <= 256 && !distribution.contains('/') && component_valid(distribution)
}
fn component_valid(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value
            .chars()
            .any(|c| c.is_control() || matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        && !value.ends_with([' ', '.'])
}
pub fn validate_linux(path: &str) -> Result<(), String> {
    let tail = path.strip_prefix('/').unwrap_or(path);
    let tail = tail.strip_suffix('/').unwrap_or(tail);
    if path.len() > 4096
        || !path.starts_with('/')
        || path.starts_with("//")
        || (path != "/" && !tail.split('/').all(component_valid))
    {
        return Err("请选择受支持的 WSL 绝对路径，不支持主机路径或特殊路径组件。".into());
    }
    Ok(())
}
pub fn to_unc(distribution: &str, path: &str) -> Result<String, String> {
    if !distribution_valid(distribution) {
        return Err("WSL 发行版无效。".into());
    }
    validate_linux(path)?;
    let path = path
        .strip_suffix('/')
        .filter(|p| !p.is_empty())
        .unwrap_or(path);
    Ok(format!(
        "\\\\wsl.localhost\\{distribution}{}",
        path.replace('/', "\\")
    ))
}
pub fn from_unc(distribution: &str, selected: &str) -> Result<String, String> {
    if !distribution_valid(distribution) || selected.len() > 8192 {
        return Err("选择的 WSL 路径无效。".into());
    }
    let parts = selected
        .strip_prefix("\\\\")
        .ok_or("仅支持已配置发行版内的 WSL 路径，不支持 Windows 主机路径。")?;
    let mut parts = parts.split('\\');
    let host = parts.next().unwrap_or("");
    let distro = parts.next().unwrap_or("");
    if !(host.eq_ignore_ascii_case("wsl.localhost") || host.eq_ignore_ascii_case("wsl$"))
        || !distro.eq_ignore_ascii_case(distribution)
    {
        return Err("只能选择已配置的 WSL 发行版，不能选择其他发行版或主机路径。".into());
    }
    let tail = parts.collect::<Vec<_>>().join("/");
    let path = if tail.is_empty() {
        "/".to_string()
    } else {
        format!("/{tail}")
    };
    validate_linux(&path)?;
    Ok(if path.len() > 1 {
        path.trim_end_matches('/').to_string()
    } else {
        path
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_configured_distribution_and_unicode_hidden_paths() {
        for path in [
            "/",
            "/home/用户/.dsh-wsl-desktop/speech",
            "/home/user/a b/python",
        ] {
            let unc = to_unc("Ubuntu-24.04", path).unwrap();
            assert!(unc.starts_with(r"\\wsl.localhost\Ubuntu-24.04\"));
            assert_eq!(from_unc("Ubuntu-24.04", &unc).unwrap(), path);
        }
        assert_eq!(
            from_unc("Ubuntu", r"\\WSL$\ubuntu\home\a").unwrap(),
            "/home/a"
        );
        assert_eq!(
            from_unc("我的 Ubuntu", &to_unc("我的 Ubuntu", "/home/test").unwrap()).unwrap(),
            "/home/test"
        );
    }
    #[test]
    fn canonicalizes_a_single_directory_separator_without_accepting_empty_components() {
        assert_eq!(
            to_unc("Ubuntu", "/home/user/").unwrap(),
            r"\\wsl.localhost\Ubuntu\home\user"
        );
        assert_eq!(
            from_unc("Ubuntu", r"\\wsl.localhost\Ubuntu\home\user\").unwrap(),
            "/home/user"
        );
        assert!(to_unc("Ubuntu", "/home/user//").is_err());
        assert!(from_unc("Ubuntu", r"\\wsl.localhost\Ubuntu\home\\user").is_err());
    }
    #[test]
    fn rejects_other_distributions_hosts_drives_and_traversal() {
        for path in [
            r"C:\Users\a",
            r"\\host\Ubuntu\a",
            r"\\wsl.localhost\Debian\home\a",
            r"\\wsl.localhost\Ubuntu.evil\a",
            r"\\?\UNC\wsl.localhost\Ubuntu\a",
            r"\\wsl.localhost\Ubuntu\..\Debian",
            r"\\wsl.localhost\Ubuntu\a:stream",
            r"\\wsl.localhost\Ubuntu\a\\b",
            r"\\wsl.localhost\Ubuntu\a.",
        ] {
            assert!(from_unc("Ubuntu", path).is_err(), "{path}");
        }
        for path in [
            "", "relative", "//host/a", "/a/../b", "/a/./b", "/a//b", "/a\\b", "/a\n", "/a//",
        ] {
            assert!(to_unc("Ubuntu", path).is_err(), "{path}");
        }
        for distro in ["", "..", "Ubuntu\\Debian", "Ubuntu/Other", "Ubuntu:bad"] {
            assert!(to_unc(distro, "/").is_err());
        }
    }
}
