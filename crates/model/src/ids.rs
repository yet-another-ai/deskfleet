use serde::{Deserialize, Serialize};

macro_rules! resource_id {
    ($($name:ident),+ $(,)?) => {
        $(
            /// A database-assigned identity, serialized as a decimal string.
            ///
            /// String encoding preserves all 64 bits in JavaScript clients.
            #[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
            #[serde(transparent)]
            pub struct $name(#[serde(with = "decimal_string")] i64);

            impl $name {
                pub const fn from_i64(value: i64) -> Self {
                    Self(value)
                }

                pub const fn as_i64(&self) -> i64 {
                    self.0
                }
            }

            impl From<i64> for $name {
                fn from(value: i64) -> Self {
                    Self(value)
                }
            }

            impl std::fmt::Display for $name {
                fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    std::fmt::Display::fmt(&self.0, formatter)
                }
            }
        )+
    };
}

mod decimal_string {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};

    pub fn serialize<S: Serializer>(value: &i64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(value)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(D::Error::custom)
    }
}

resource_id!(
    TeamId,
    MachineId,
    WorkspaceId,
    WorktreeId,
    AgentSessionId,
    TerminalSessionId,
    AgentCommandId,
    AgentInputId,
    AgentTurnId,
    AgentPermissionId,
    AgentElicitationId,
    AgentSequence,
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_ids_preserve_all_64_bits_as_decimal_strings() {
        for value in [1, 9_007_199_254_740_993, i64::MAX, i64::MIN] {
            let id = WorktreeId::from_i64(value);
            assert_eq!(id.as_i64(), value);
            let wire = serde_json::to_value(id).unwrap();
            assert_eq!(wire, serde_json::json!(value.to_string()));
            assert_eq!(serde_json::from_value::<WorktreeId>(wire).unwrap(), id);
        }
    }

    #[test]
    fn resource_ids_reject_numbers_and_invalid_decimal_strings() {
        for wire in [
            serde_json::json!(9_007_199_254_740_993_i64),
            serde_json::json!(""),
            serde_json::json!("1.5"),
            serde_json::json!("9223372036854775808"),
            serde_json::json!("workspace-one"),
        ] {
            assert!(serde_json::from_value::<WorkspaceId>(wire).is_err());
        }
    }
}
