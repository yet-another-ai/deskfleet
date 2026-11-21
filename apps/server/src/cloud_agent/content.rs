use super::hash;
use crate::error::{ApiError, Result as ApiResult};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{self, SeqAccess, Visitor},
};
use std::fmt;

const MAX_PARTS: usize = 64;

/// The public message formats supported by the pinned eve HTTP channel.
#[derive(Serialize)]
#[serde(untagged)]
pub(super) enum Message {
    Text(String),
    Parts(Vec<Part>),
}

// Decode directly into the chosen wire type. An untagged deserializer would
// buffer the entire array before enforcing eve's part limit.
impl<'de> Deserialize<'de> for Message {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct MessageVisitor;
        impl<'de> Visitor<'de> for MessageVisitor {
            type Value = Message;

            fn expecting(&self, fmt: &mut fmt::Formatter<'_>) -> fmt::Result {
                fmt.write_str("a message string or an array of 1 to 64 text or file parts")
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Message, E> {
                Ok(Message::Text(value.to_owned()))
            }

            fn visit_string<E: de::Error>(self, value: String) -> Result<Message, E> {
                Ok(Message::Text(value))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Message, A::Error> {
                let mut parts = Vec::new();
                while let Some(part) = seq.next_element()? {
                    if parts.len() == MAX_PARTS {
                        return Err(de::Error::invalid_length(MAX_PARTS + 1, &self));
                    }
                    parts.push(part);
                }
                Ok(Message::Parts(parts))
            }
        }
        deserializer.deserialize_any(MessageVisitor)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Part {
    Text {
        text: String,
    },
    File {
        #[serde(rename = "mediaType")]
        media_type: String,
        data: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
    },
}

impl Message {
    /// Only an omitted message means "prewarm". An explicit null is invalid.
    pub(super) fn present<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Self>, D::Error> {
        Self::deserialize(deserializer).map(Some)
    }

    pub(super) fn validate(&self) -> ApiResult<()> {
        match self {
            Self::Text(text) if text.trim().is_empty() => {
                Err(ApiError::bad("message must contain text"))
            }
            Self::Text(_) => Ok(()),
            Self::Parts(parts) => {
                if parts
                    .iter()
                    .all(|part| matches!(part, Part::Text { text } if text.trim().is_empty()))
                {
                    return Err(ApiError::bad("message must contain text or a file"));
                }
                for part in parts {
                    match part {
                        Part::Text { text } if text.is_empty() => {
                            return Err(ApiError::bad("text parts require nonempty text"));
                        }
                        Part::File {
                            media_type, data, ..
                        } => {
                            if media_type.trim().is_empty() {
                                return Err(ApiError::bad("file parts require a mediaType"));
                            }
                            // Internal references are issued by eve and belong to its sandbox.
                            if data
                                .trim_start()
                                .split_once(':')
                                .is_some_and(|(scheme, _)| {
                                    ["eve-url", "eve-sandbox", "chat-sdk-file"]
                                        .iter()
                                        .any(|reserved| scheme.eq_ignore_ascii_case(reserved))
                                })
                            {
                                return Err(ApiError::bad("invalid file reference"));
                            }
                        }
                        Part::Text { .. } => {}
                    }
                }
                Ok(())
            }
        }
    }

    pub(super) fn fingerprint(&self, operation: &str, session: &str) -> String {
        // The existing string fingerprint must still match pre-upgrade receipts.
        let mut fields = vec![operation, session];
        match self {
            Self::Text(text) => fields.push(text),
            Self::Parts(parts) => {
                fields.push("parts");
                for part in parts {
                    match part {
                        Part::Text { text } => fields.extend(["text", text.as_str()]),
                        Part::File {
                            media_type,
                            data,
                            filename,
                        } => {
                            fields.extend(["file", media_type.as_str(), data.as_str()]);
                            if let Some(name) = filename {
                                fields.extend(["filename", name.as_str()]);
                            }
                        }
                    }
                }
            }
        }
        hash(&fields)
    }

    pub(super) fn title(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            Self::Parts(parts) => parts
                .iter()
                .find_map(|part| match part {
                    Part::Text { text } if !text.trim().is_empty() => Some(text.as_str()),
                    _ => None,
                })
                .or_else(|| {
                    parts.iter().find_map(|part| match part {
                        Part::File {
                            filename: Some(name),
                            ..
                        } if !name.trim().is_empty() => Some(name.as_str()),
                        _ => None,
                    })
                }),
        }
    }
}
