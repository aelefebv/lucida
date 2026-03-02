// exports startup/app wiring for tests
pub mod config;

use std::ffi::OsString;

use config::{parse_args_from, validate_startup_file_path, StartupArgs};

pub fn run_startup<I, T>(args: I) -> Result<StartupArgs, String>
where 
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let startup_args = parse_args_from(args).map_err(|err| err.to_string())?;
    validate_startup_file_path(&startup_args)?;
    Ok(startup_args)
}

