// process entrypoint

fn main() {
    if let Err(err) = server::run_startup(std::env::args_os()) {
        eprintln!("{err}");
        std::process::exit(1);
    }
}
