/// Normalize only Git's uniform LF-to-CRLF checkout conversion.
/// Mixed endings and lone carriage returns are not a faithful checkout.
pub fn canonical_git_text(local: &[u8]) -> Option<Vec<u8>> {
    let windows_lines = local.windows(2).any(|pair| pair == b"\r\n");
    let mut canonical = Vec::with_capacity(local.len());
    let mut offset = 0;
    while offset < local.len() {
        match local[offset] {
            b'\r' if windows_lines && local.get(offset + 1) == Some(&b'\n') => {
                canonical.push(b'\n');
                offset += 2;
            }
            b'\r' => return None,
            b'\n' if windows_lines => return None,
            byte => {
                canonical.push(byte);
                offset += 1;
            }
        }
    }
    Some(canonical)
}

#[cfg(test)]
mod tests {
    use super::canonical_git_text;

    #[test]
    fn accepts_only_exact_lf_or_uniform_windows_checkout() {
        let committed = b"line one\nline two\n";
        assert_eq!(
            canonical_git_text(committed).as_deref(),
            Some(committed.as_slice())
        );
        assert_eq!(
            canonical_git_text(b"line one\r\nline two\r\n").as_deref(),
            Some(committed.as_slice())
        );
        assert_ne!(
            canonical_git_text(b"line one\r\nchanged\r\n").as_deref(),
            Some(committed.as_slice())
        );
        assert_eq!(canonical_git_text(b"line one\r\nline two\n"), None);
        assert_eq!(canonical_git_text(b"line one\rline two\n"), None);
    }
}
