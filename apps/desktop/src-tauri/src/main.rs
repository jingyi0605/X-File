fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) == Some("library-worker") {
        std::process::exit(x_file_desktop_lib::run_library_worker_cli_from_args(&args));
    }
    x_file_desktop_lib::run();
}
