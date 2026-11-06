//! Retain the initialization settings needed for a bitrate-only reconfigure.

use std::ffi::c_void;
use std::ptr;

use deskfleet_nvenc_sys::{
    NV_ENC_CAPS, NV_ENC_CAPS_PARAM, NV_ENC_CAPS_PARAM_VER, NV_ENC_CONFIG, NV_ENC_INITIALIZE_PARAMS,
    NV_ENC_RECONFIGURE_PARAMS, NV_ENC_RECONFIGURE_PARAMS_VER, NV_ENCODE_API_FUNCTION_LIST,
    NVENCSTATUS,
};

use crate::NvEncError;

pub(crate) struct RateControl {
    init: NV_ENC_INITIALIZE_PARAMS,
    config: NV_ENC_CONFIG,
}

impl RateControl {
    pub(crate) fn new(mut init: NV_ENC_INITIALIZE_PARAMS, config: NV_ENC_CONFIG) -> Self {
        // Never retain the pointer to the constructor's stack-local configuration.
        // Each synchronous call below supplies its own live configuration pointer.
        init.encodeConfig = ptr::null_mut();
        Self { init, config }
    }

    /// # Safety
    /// `encoder` must be the live NVENC session initialized with these settings;
    /// `fns` must belong to its loaded API. The session must be exclusively held.
    pub(crate) unsafe fn set_bitrate(
        &mut self,
        fns: &NV_ENCODE_API_FUNCTION_LIST,
        encoder: *mut c_void,
        average: u32,
        maximum: u32,
    ) -> Result<(), NvEncError> {
        if average == 0 || (maximum != 0 && maximum < average) {
            return Err(NvEncError::ReconfigureFailed(
                NVENCSTATUS::NV_ENC_ERR_INVALID_PARAM,
            ));
        }
        let query = fns
            .nvEncGetEncodeCaps
            .ok_or(NvEncError::DynamicBitrateUnsupported)?;
        let reconfigure = fns
            .nvEncReconfigureEncoder
            .ok_or(NvEncError::DynamicBitrateUnsupported)?;
        let mut caps = NV_ENC_CAPS_PARAM {
            version: NV_ENC_CAPS_PARAM_VER,
            capsToQuery: NV_ENC_CAPS::NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE,
            ..Default::default()
        };
        let mut supported = 0;
        // SAFETY: the caller guarantees a live session/API, and both outputs are
        // initialized and valid for the synchronous capability query.
        let status = unsafe {
            query(
                encoder,
                self.init.encodeGUID,
                &raw mut caps,
                &raw mut supported,
            )
        };
        if status != NVENCSTATUS::NV_ENC_SUCCESS {
            return Err(NvEncError::Api(status));
        }
        if supported == 0 {
            return Err(NvEncError::DynamicBitrateUnsupported);
        }

        self.update(average, maximum, |params| {
            // SAFETY: all structures (including the nested configuration pointer)
            // stay alive until this synchronous call returns; session access is exclusive.
            unsafe { reconfigure(encoder, params) }
        })
    }

    fn update(
        &mut self,
        average: u32,
        maximum: u32,
        reconfigure: impl FnOnce(&mut NV_ENC_RECONFIGURE_PARAMS) -> NVENCSTATUS,
    ) -> Result<(), NvEncError> {
        let mut config = self.config;
        config.rcParams.averageBitRate = average;
        config.rcParams.maxBitRate = if maximum == 0 { average } else { maximum };
        let mut params = NV_ENC_RECONFIGURE_PARAMS {
            version: NV_ENC_RECONFIGURE_PARAMS_VER,
            reInitEncodeParams: self.init,
            ..Default::default()
        };
        params.reInitEncodeParams.encodeConfig = &raw mut config;
        // Keep resetEncoder and forceIDR clear. Rate changes must preserve the
        // reference chain and avoid injecting a fresh IDR on every GCC update.
        let status = reconfigure(&mut params);
        if status != NVENCSTATUS::NV_ENC_SUCCESS {
            return Err(NvEncError::ReconfigureFailed(status));
        }
        self.config = config;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use deskfleet_nvenc_sys::{
        NV_ENC_CONFIG_VER, NV_ENC_INITIALIZE_PARAMS_VER, NV_ENC_PARAMS_RC_MODE,
    };

    fn settings() -> RateControl {
        let mut config = NV_ENC_CONFIG {
            version: NV_ENC_CONFIG_VER,
            gopLength: 1000,
            frameIntervalP: 1,
            ..Default::default()
        };
        config.rcParams.rateControlMode = NV_ENC_PARAMS_RC_MODE::NV_ENC_PARAMS_RC_CBR;
        config.rcParams.averageBitRate = 8_000_000;
        config.rcParams.maxBitRate = 10_000_000;
        config.rcParams.vbvBufferSize = 200_000;
        let init = NV_ENC_INITIALIZE_PARAMS {
            version: NV_ENC_INITIALIZE_PARAMS_VER,
            encodeGUID: deskfleet_nvenc_sys::NV_ENC_CODEC_H264_GUID,
            encodeWidth: 1920,
            encodeHeight: 1080,
            frameRateNum: 60_000,
            frameRateDen: 1000,
            enablePTD: 1,
            encodeConfig: &raw mut config,
            ..Default::default()
        };
        RateControl::new(init, config)
    }

    #[test]
    fn bitrate_change_preserves_session_settings_and_reference_chain() {
        let mut state = settings();
        assert!(state.init.encodeConfig.is_null());
        state
            .update(2_000_000, 4_000_000, |params| {
                assert_eq!(params.version, NV_ENC_RECONFIGURE_PARAMS_VER);
                assert_eq!(params.resetEncoder(), 0);
                assert_eq!(params.forceIDR(), 0);
                let init = &params.reInitEncodeParams;
                assert_eq!(init.version, NV_ENC_INITIALIZE_PARAMS_VER);
                assert_eq!((init.encodeWidth, init.encodeHeight), (1920, 1080));
                assert_eq!((init.frameRateNum, init.frameRateDen), (60_000, 1000));
                assert_eq!(init.enablePTD, 1);
                // SAFETY: update supplies a live local config for this callback.
                let config = unsafe { &*init.encodeConfig };
                assert_eq!(config.version, NV_ENC_CONFIG_VER);
                assert_eq!((config.gopLength, config.frameIntervalP), (1000, 1));
                assert_eq!(config.rcParams.vbvBufferSize, 200_000);
                assert_eq!(config.rcParams.averageBitRate, 2_000_000);
                assert_eq!(config.rcParams.maxBitRate, 4_000_000);
                assert_eq!(
                    config.rcParams.rateControlMode,
                    NV_ENC_PARAMS_RC_MODE::NV_ENC_PARAMS_RC_CBR
                );
                NVENCSTATUS::NV_ENC_SUCCESS
            })
            .unwrap();
        assert_eq!(state.config.rcParams.averageBitRate, 2_000_000);
        assert_eq!(state.config.rcParams.maxBitRate, 4_000_000);
        assert!(state.init.encodeConfig.is_null());
    }

    #[test]
    fn failed_reconfigure_preserves_last_applied_settings() {
        let mut state = settings();
        let result = state.update(2_000_000, 0, |_| NVENCSTATUS::NV_ENC_ERR_GENERIC);
        assert!(matches!(result, Err(NvEncError::ReconfigureFailed(_))));
        assert_eq!(state.config.rcParams.averageBitRate, 8_000_000);
        assert_eq!(state.config.rcParams.maxBitRate, 10_000_000);
        state
            .update(3_000_000, 0, |_| NVENCSTATUS::NV_ENC_SUCCESS)
            .unwrap();
        assert_eq!(state.config.rcParams.averageBitRate, 3_000_000);
        assert_eq!(state.config.rcParams.maxBitRate, 3_000_000);
    }
}
