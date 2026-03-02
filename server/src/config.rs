// args + validated config
use std::path::PathBuf;
use std::ffi::OsString;

use clap::Parser;

pub const DEFAULT_PORT: u16 = 8080;

#[derive(Debug, Clone, PartialEq, Eq, Parser)]
#[command(name = "lucida")]
pub struct StartupArgs{
    #[arg(long)]
    pub file: PathBuf,

    #[arg(long, default_value_t = DEFAULT_PORT)]
    pub port: u16,
}

pub fn parse_args_from<I, T>(args: I) -> Result<StartupArgs, clap::Error>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    StartupArgs::try_parse_from(args)
}

pub fn validate_startup_file_path(args: &StartupArgs) -> Result<(), String> {
    if !args.file.exists() {
        return Err(format!("File path does not exist: {}", args.file.display()));
    }
    if !args.file.is_file() {
        return Err(format!("Path is not a file: {}", args.file.display()));
    }
    Ok(())
}