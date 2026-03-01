use std::process::ExitCode;

use lucida_engine::validate_generation_layout;

fn main() -> ExitCode {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() != 4 {
        eprintln!("usage: storage_layout_validate <cache_root> <source_id> <generation_seq>");
        return ExitCode::FAILURE;
    }

    let cache_root = &args[1];
    let source_id = &args[2];
    let generation_seq = match args[3].parse::<u64>() {
        Ok(value) => value,
        Err(_) => {
            eprintln!("generation_seq must be an integer");
            return ExitCode::FAILURE;
        }
    };

    let report = match validate_generation_layout(cache_root, source_id, generation_seq) {
        Ok(report) => report,
        Err(error) => {
            eprintln!("validation failed to run: {error:?}");
            return ExitCode::FAILURE;
        }
    };

    match serde_json::to_string_pretty(&report) {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("failed to serialize report: {error}");
            return ExitCode::FAILURE;
        }
    }

    if report.valid {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
