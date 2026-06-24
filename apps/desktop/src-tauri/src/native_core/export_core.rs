use serde_json::Value;

use crate::native_export::{run_native_export_worker, NativeExportRequest};

pub type NativeLibraryExportCoreRequest = NativeExportRequest;

pub fn run_native_library_export_core(
    request: NativeLibraryExportCoreRequest,
) -> Result<Value, String> {
    run_native_export_worker(request)
}
