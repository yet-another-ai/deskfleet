use crate::{InputError, Result};

pub(super) struct PlatformInput;

impl PlatformInput {
    pub(super) fn new(_: u32) -> Result<Self> {
        Err(InputError::Unsupported("this operating system"))
    }
    pub(super) fn move_pointer(&mut self, _: f64, _: f64) -> Result<()> {
        Err(InputError::Unsupported("this operating system"))
    }
    pub(super) fn button(&mut self, _: u8, _: bool) -> Result<()> {
        Err(InputError::Unsupported("this operating system"))
    }
    pub(super) fn wheel(&mut self, _: f64, _: f64) -> Result<()> {
        Err(InputError::Unsupported("this operating system"))
    }
    pub(super) fn key(&mut self, _: &str, _: bool, _: bool) -> Result<()> {
        Err(InputError::Unsupported("this operating system"))
    }
}
