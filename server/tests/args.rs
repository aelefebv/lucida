// CLI behavior
/* parse_args_from(args) -> Result<StartupArgs, _>
StartupArgs { file: PathBuf, port: u16 }
DEFAULT_PORT: u16 */

use std::path::PathBuf;

use server::config::{parse_args_from, DEFAULT_PORT};

#[test]
fn uses_default_port_when_port_not_provided() {
    let args = ["lucida", "--file", "/tmp/data.ome.zarr"];
    
    let parsed = parse_args_from(args).expect("args should parse");
    
    assert_eq!(parsed.file, PathBuf::from("/tmp/data.ome.zarr"));
    assert_eq!(parsed.port, DEFAULT_PORT);
}

#[test]
fn uses_explicit_port_when_provided() {
    let args = ["lucida", "--file", "/tmp/data.ome.zarr", "--port", "9090"];
    
    let parsed = parse_args_from(args).expect("args should parse");
    
    assert_eq!(parsed.file, PathBuf::from("/tmp/data.ome.zarr"));
    assert_eq!(parsed.port, 9090);
}
