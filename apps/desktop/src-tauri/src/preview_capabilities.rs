use serde::Deserialize;
use std::sync::OnceLock;

const PREVIEW_MANIFEST: &str = include_str!("../../../../packages/shared/src/library-preview-capabilities.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFormat {
    pub extensions: Vec<String>,
    pub preview_kind: String,
    pub adapter_family: String,
    pub previewable: bool,
    pub editable: bool,
    pub resource_class: String,
    pub native_bytes: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct PreviewManifest {
    formats: Vec<PreviewFormat>,
    budgets: PreviewBudgets,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewBudgets {
    pub text_max_bytes: u64,
    pub edit_max_bytes: u64,
    pub resource_max_bytes: u64,
}

fn formats() -> &'static [PreviewFormat] {
    static FORMATS: OnceLock<Vec<PreviewFormat>> = OnceLock::new();
    FORMATS
        .get_or_init(|| {
            serde_json::from_str::<PreviewManifest>(PREVIEW_MANIFEST)
                .expect("shared preview capability manifest must be valid JSON")
                .formats
        })
        .as_slice()
}

pub fn format_for_extension(extension: &str) -> Option<PreviewFormat> {
    let normalized = format!(".{}", extension.trim_start_matches('.').to_ascii_lowercase());
    formats()
        .iter()
        .find(|definition| definition.extensions.iter().any(|item| item == &normalized))
        .cloned()
}

pub fn budgets() -> &'static PreviewBudgets {
    static BUDGETS: OnceLock<PreviewBudgets> = OnceLock::new();
    BUDGETS.get_or_init(|| {
        serde_json::from_str::<PreviewManifest>(PREVIEW_MANIFEST)
            .expect("shared preview capability manifest must be valid JSON")
            .budgets
    })
}

#[cfg(test)]
mod tests {
    use super::{format_for_extension, formats};
    use std::collections::HashSet;

    #[test]
    fn shared_manifest_has_unique_normalized_extensions() {
        let mut seen = HashSet::new();
        for format in formats() {
            for extension in &format.extensions {
                assert!(extension.starts_with('.'));
                assert_eq!(extension, &extension.to_ascii_lowercase());
                assert!(seen.insert(extension.clone()), "duplicate extension: {extension}");
            }
        }
    }

    #[test]
    fn explicit_formats_match_web_and_server_preview_families() {
        assert_eq!(format_for_extension("MD").unwrap().preview_kind, "markdown");
        assert_eq!(format_for_extension("mdx").unwrap().preview_kind, "text");
        assert_eq!(format_for_extension("CSV").unwrap().adapter_family, "delimited-text");
        assert_eq!(format_for_extension("xlsx").unwrap().adapter_family, "spreadsheet");
        assert!(!format_for_extension("doc").unwrap().previewable);
        assert!(format_for_extension("txt").unwrap().editable);
        assert!(!format_for_extension("docx").unwrap().editable);
        assert!(format_for_extension("pdf").unwrap().previewable);
    }
}
