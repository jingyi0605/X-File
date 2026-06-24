use serde_json::Value;

use crate::native_index::{run_native_index_worker, NativeIndexRequest};

pub type NativeLibraryIndexCoreRequest = NativeIndexRequest;

pub fn run_native_library_index_core(
    request: NativeLibraryIndexCoreRequest,
) -> Result<Value, String> {
    run_native_index_worker(request)
}
