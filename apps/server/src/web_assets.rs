//! Optional hosting of the built Web client alongside the control-plane API.

use std::{env, fs::File, io, path::PathBuf};

use actix_files::{Files, NamedFile};
use actix_web::{HttpRequest, HttpResponse, http::header, web};

/// A validated Web build directory, shared by each HTTP worker.
#[derive(Clone, Debug)]
pub struct WebAssets {
    directory: PathBuf,
}

impl WebAssets {
    /// Load optional `DESKFLEET_WEB_DIRECTORY` before the HTTP listener starts.
    /// An absent or empty value leaves the server's API-only mode enabled.
    pub fn from_env() -> io::Result<Option<Self>> {
        env::var_os("DESKFLEET_WEB_DIRECTORY")
            .filter(|directory| !directory.is_empty())
            .map(|directory| Self::load(PathBuf::from(directory)))
            .transpose()
    }

    fn load(directory: PathBuf) -> io::Result<Self> {
        let validate = || {
            let directory = directory.canonicalize()?;
            let index = File::open(directory.join("index.html"))?;
            if !index.metadata()?.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "index.html is not a regular file",
                ));
            }
            Ok(Self { directory })
        };
        validate().map_err(|error: io::Error| {
            io::Error::new(
                error.kind(),
                format!("DESKFLEET_WEB_DIRECTORY must contain a readable index.html: {error}"),
            )
        })
    }

    /// Register after the API and health routes so they retain their own errors.
    pub fn configure(&self, config: &mut web::ServiceConfig) {
        config.app_data(web::Data::new(self.clone()));
        // Main application routes use URL hashes; only authentication uses path routing.
        config.service(
            web::resource(["/", "/index.html", "/auth/{page:.*}"])
                .route(web::get().to(index))
                .route(web::head().to(index)),
        );
        config.service(Files::new("/", self.directory.clone()).prefer_utf8(true));
    }
}

async fn index(
    request: HttpRequest,
    assets: web::Data<WebAssets>,
) -> actix_web::Result<HttpResponse> {
    let path = assets.directory.join("index.html");
    let file = web::block(move || NamedFile::open(path)).await??;
    let mut response = file.into_response(&request);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-cache"),
    );
    Ok(response)
}

#[cfg(test)]
mod tests;
