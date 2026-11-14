#ifndef DESKFLEET_KMP_BRIDGE_H
#define DESKFLEET_KMP_BRIDGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

char *deskfleet_kmp_last_error(void);
void deskfleet_kmp_string_free(char *ptr);

uint64_t deskfleet_kmp_peer_create(const char *config_json);
bool deskfleet_kmp_peer_create_data_channel(uint64_t handle, const char *label);
char *deskfleet_kmp_peer_create_offer(uint64_t handle);
char *deskfleet_kmp_peer_answer_offer(uint64_t handle, const char *sdp);
bool deskfleet_kmp_peer_accept_answer(uint64_t handle, const char *sdp);
bool deskfleet_kmp_peer_add_ice_candidate(uint64_t handle, const char *candidate_json);
bool deskfleet_kmp_peer_send_bytes(uint64_t handle, const char *label, const uint8_t *data, size_t len);
bool deskfleet_kmp_peer_send_text(uint64_t handle, const char *label, const char *text);
char *deskfleet_kmp_peer_poll_event(uint64_t handle, uint64_t timeout_ms);
int32_t deskfleet_kmp_peer_copy_video_frame(
    uint64_t handle,
    uint64_t after_seq,
    uint8_t *out_bgra,
    size_t out_capacity,
    uint32_t *out_width,
    uint32_t *out_height,
    uint64_t *out_seq
);
void deskfleet_kmp_peer_close(uint64_t handle);

char *deskfleet_kmp_test_nat(const char *server);
char *deskfleet_kmp_request_local_network(void);
bool deskfleet_kmp_open_local_network_settings(void);

#ifdef __cplusplus
}
#endif

#endif
