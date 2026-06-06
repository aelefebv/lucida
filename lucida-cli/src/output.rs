use serde::Serialize;

use crate::error::CliError;

#[derive(Debug, Clone, Copy)]
pub struct Output {
    json: bool,
    quiet: bool,
}

impl Output {
    pub fn new(json: bool, quiet: bool) -> Self {
        Self { json, quiet }
    }

    pub fn print_json<T: Serialize>(self, value: &T) -> Result<(), CliError> {
        if self.quiet {
            return Ok(());
        }
        println!("{}", serde_json::to_string_pretty(value)?);
        Ok(())
    }

    pub fn print_human(self, text: impl AsRef<str>) {
        if !self.quiet {
            println!("{}", text.as_ref());
        }
    }

    pub fn print_either<T: Serialize>(
        self,
        value: &T,
        human: impl FnOnce() -> String,
    ) -> Result<(), CliError> {
        if self.json {
            self.print_json(value)
        } else {
            self.print_human(human());
            Ok(())
        }
    }
}
