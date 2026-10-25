use crate::{Backend, InputError, InputEvent, Result};

pub(super) struct Controller<B: Backend> {
    backend: B,
    keys: Vec<String>,
    buttons: Vec<u8>,
}

impl<B: Backend> Controller<B> {
    pub(super) fn new(backend: B) -> Self {
        Self {
            backend,
            keys: Vec::new(),
            buttons: Vec::new(),
        }
    }

    pub(super) fn handle(&mut self, event: InputEvent) -> Result<()> {
        let result = event.validate().and_then(|()| self.apply(event));
        if result.is_err()
            && let Err(error) = self.release_all()
        {
            tracing::warn!(%error, "desktop input cleanup failed");
        }
        result
    }

    fn apply(&mut self, event: InputEvent) -> Result<()> {
        match event {
            InputEvent::PointerMove { x, y } => self.backend.move_pointer(x, y),
            InputEvent::PointerButton {
                button,
                pressed,
                x,
                y,
            } => {
                // Even a click without an earlier pointer move targets its own position.
                self.backend.move_pointer(x, y)?;
                let held = self.buttons.contains(&button);
                if pressed == held {
                    return Ok(());
                }
                self.backend.button(button, pressed)?;
                if pressed {
                    self.buttons.push(button);
                } else {
                    self.buttons.retain(|value| *value != button);
                }
                Ok(())
            }
            InputEvent::Wheel { delta_x, delta_y } => self.backend.wheel(delta_x, delta_y),
            InputEvent::Key {
                code,
                pressed,
                repeat,
            } => {
                let held = self.keys.contains(&code);
                // Ignore releases of local keys and stale auto-repeat after focus loss.
                if (!pressed || repeat) && !held || pressed && held && !repeat {
                    return Ok(());
                }
                match self.backend.key(&code, pressed, repeat) {
                    // Mapping misses do not disturb other held keys or buttons.
                    Err(InputError::UnsupportedKey) => return Ok(()),
                    result => result?,
                }
                if pressed && !held {
                    self.keys.push(code);
                } else if !pressed {
                    self.keys.retain(|value| value != &code);
                }
                Ok(())
            }
            InputEvent::ReleaseAll => self.release_all(),
        }
    }

    pub(super) fn release_all(&mut self) -> Result<()> {
        let mut first_error = None;
        // Reverse press order releases ordinary keys before earlier modifiers.
        for index in (0..self.keys.len()).rev() {
            match self.backend.key(&self.keys[index], false, false) {
                Ok(()) => {
                    self.keys.remove(index);
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        for index in (0..self.buttons.len()).rev() {
            match self.backend.button(self.buttons[index], false) {
                Ok(()) => {
                    self.buttons.remove(index);
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

impl<B: Backend> Drop for Controller<B> {
    fn drop(&mut self) {
        if let Err(error) = self.release_all() {
            tracing::warn!(%error, "desktop input release on close failed");
        }
    }
}

#[cfg(test)]
mod tests;
