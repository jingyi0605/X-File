use serde_json::Value;

use crate::native_export::{run_native_search_worker, NativeSearchRequest};

pub type NativeLibrarySearchCoreRequest = NativeSearchRequest;

pub fn run_native_library_search_core(
    request: NativeLibrarySearchCoreRequest,
) -> Result<Value, String> {
    run_native_search_worker(request)
}
