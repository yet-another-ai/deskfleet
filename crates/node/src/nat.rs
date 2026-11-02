//! Thin Node-API adapter for native NAT diagnostics.

use deskfleet_native::nat;
use napi::Result;
use napi_derive::napi;

use crate::rtc::native_error;

#[napi(string_enum = "kebab-case")]
pub enum NatMapping {
    Unknown,
    Direct,
    EndpointIndependent,
    AddressDependent,
    AddressAndPortDependent,
}

#[napi(string_enum = "kebab-case")]
pub enum NatFiltering {
    Unknown,
    EndpointIndependent,
    AddressDependent,
    AddressAndPortDependent,
}

#[napi(string_enum = "kebab-case")]
pub enum NatTestStatus {
    Complete,
    ServerUnsupported,
    Inconclusive,
    UdpUnreachable,
}

#[napi(object)]
pub struct NatTestResult {
    pub server: String,
    pub local_address: String,
    pub public_address: Option<String>,
    pub mapping: NatMapping,
    pub filtering: NatFiltering,
    pub status: NatTestStatus,
    pub duration_ms: u32,
}

/// Discover IPv4 NAT behavior using a user-selected RFC 5780 STUN host:port.
#[napi]
pub async fn test_nat(server: String) -> Result<NatTestResult> {
    let result = nat::test_nat(&server).await.map_err(native_error)?;
    Ok(NatTestResult {
        server: result.server.to_string(),
        local_address: result.local_address.to_string(),
        public_address: result.public_address.map(|address| address.to_string()),
        mapping: match result.mapping {
            nat::NatMapping::Unknown => NatMapping::Unknown,
            nat::NatMapping::Direct => NatMapping::Direct,
            nat::NatMapping::EndpointIndependent => NatMapping::EndpointIndependent,
            nat::NatMapping::AddressDependent => NatMapping::AddressDependent,
            nat::NatMapping::AddressAndPortDependent => NatMapping::AddressAndPortDependent,
        },
        filtering: match result.filtering {
            nat::NatFiltering::Unknown => NatFiltering::Unknown,
            nat::NatFiltering::EndpointIndependent => NatFiltering::EndpointIndependent,
            nat::NatFiltering::AddressDependent => NatFiltering::AddressDependent,
            nat::NatFiltering::AddressAndPortDependent => NatFiltering::AddressAndPortDependent,
        },
        status: match result.status {
            nat::NatTestStatus::Complete => NatTestStatus::Complete,
            nat::NatTestStatus::ServerUnsupported => NatTestStatus::ServerUnsupported,
            nat::NatTestStatus::Inconclusive => NatTestStatus::Inconclusive,
            nat::NatTestStatus::UdpUnreachable => NatTestStatus::UdpUnreachable,
        },
        duration_ms: u32::try_from(result.duration.as_millis()).unwrap_or(u32::MAX),
    })
}
