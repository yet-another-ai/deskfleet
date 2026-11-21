//! The Monitor panel: received bitrate, frame rate, and network health.

use nsh_core::prelude::*;

use super::bar::{dot, quality_color, quality_key};
use super::widgets::{hint, note, shell};
use super::{Live, Panel, ToolbarState};
use crate::nsh_ui::{self, Palette, label};
use crate::stream_stats::{HISTORY, StreamStats};

const SPARK_HEIGHT: f32 = 32.;

/// A bitrate as a number and its unit, at a precision people compare.
pub(super) fn bitrate(bps: u64) -> (String, &'static str) {
    if bps >= 1_000_000 {
        (format!("{:.1}", bps as f64 / 1e6), "Mbps")
    } else {
        (format!("{}", (bps + 500) / 1000), "kbps")
    }
}

fn badge(stats: &StreamStats, locale: Option<&str>, p: Palette) -> impl IntoElement + use<> {
    let quality = stats.quality();
    view()
        .flex_row()
        .items_center()
        .gap(px(6.))
        .h(px(22.))
        .px(px(8.))
        .rounded(px(11.))
        .border_1()
        .border_color(rgb(p.border))
        .child(dot(quality_color(quality, p)))
        .child(
            text(label(locale, quality_key(quality)))
                .text_size(px(12.))
                .text_color(rgb(p.text)),
        )
}

/// One series, so no legend: the caption below names it. Older samples are
/// de-emphasized and the newest carries the accent.
fn sparkline(history: &[u64], p: Palette) -> impl IntoElement + use<> {
    let peak = history.iter().copied().max().unwrap_or(0).max(1) as f32;
    let mut bars = view()
        .flex_row()
        .items_end()
        .gap(px(2.))
        .h(px(SPARK_HEIGHT));
    for _ in history.len()..HISTORY {
        bars = bars.child(view().flex_1());
    }
    for (index, &sample) in history.iter().enumerate() {
        let newest = index + 1 == history.len();
        let (value, unit) = bitrate(sample);
        bars = bars.child(
            view()
                .flex_1()
                .h(px((sample as f32 / peak * SPARK_HEIGHT).max(2.)))
                .rounded_t(px(2.))
                .bg(rgb(if newest { p.accent } else { p.faint }))
                .opacity(if newest { 1. } else { 0.55 })
                .tooltip(hint(format!("{value} {unit}"), p)),
        );
    }
    bars
}

fn tile(title: String, value: String, p: Palette) -> impl IntoElement {
    view()
        .flex_1()
        .min_w(px(0.))
        .gap(px(2.))
        .py(px(8.))
        .px(px(10.))
        .rounded(px(8.))
        .bg(rgb(p.hover))
        .child(
            text(title)
                .truncate()
                .text_size(px(11.))
                .text_color(rgb(p.muted)),
        )
        .child(
            text(value)
                .truncate()
                .text_size(px(14.))
                .font_weight(FontWeight::SEMIBOLD)
                .tabular_nums()
                .text_color(rgb(p.text)),
        )
}

fn tiles(state: &ToolbarState, stats: &StreamStats, p: Palette) -> impl IntoElement + use<> {
    let locale = state.ui.locale.as_deref();
    let live = |value: String| if stats.live { value } else { "—".into() };
    let codec = nsh_ui::codec_label(state.ui.codec);
    let values = [
        ("frameRate", live(format!("{:.0} fps", stats.fps))),
        (
            "packetLoss",
            live(format!("{:.1}%", stats.packet_loss * 100.)),
        ),
        ("jitter", live(format!("{:.0} ms", stats.jitter_ms))),
        (
            "resolution",
            live(format!("{}×{}", stats.width, stats.height)),
        ),
        ("codec", if codec.is_empty() { "—" } else { codec }.into()),
        ("packetsLost", stats.packets_lost.to_string()),
        ("skippedFrames", stats.skipped_frames.to_string()),
        ("keyframeRequests", stats.keyframe_requests.to_string()),
    ];
    let mut grid = view().gap(px(6.));
    for pair in values.chunks(2) {
        let mut row = view().flex_row().gap(px(6.));
        for (key, value) in pair {
            row = row.child(tile(label(locale, key), value.clone(), p));
        }
        grid = grid.child(row);
    }
    grid
}

fn body(state: &ToolbarState, stats: &StreamStats, p: Palette) -> impl IntoElement + use<> {
    let locale = state.ui.locale.as_deref();
    let (value, unit) = if stats.live {
        bitrate(stats.bitrate_bps)
    } else {
        ("—".into(), "")
    };
    view()
        .gap(px(14.))
        .child(
            view()
                .gap(px(6.))
                .child(note(label(locale, "bitrate"), p.muted))
                .child(
                    view()
                        .flex_row()
                        .items_end()
                        .gap(px(4.))
                        .child(
                            text(value)
                                .text_size(px(28.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .tabular_nums()
                                .text_color(rgb(p.text)),
                        )
                        .child(
                            text(unit)
                                .pb(px(5.))
                                .text_size(px(13.))
                                .text_color(rgb(p.muted)),
                        ),
                )
                .child(sparkline(&stats.history, p))
                .child(note(label(locale, "monitorHint"), p.muted)),
        )
        .child(tiles(state, stats, p))
}

pub(super) fn panel(state: &ToolbarState, live: Live, p: Palette) -> impl IntoElement + use<> {
    let locale = state.ui.locale.clone();
    let snapshot = state.clone();
    shell(
        state,
        Panel::Monitor,
        label(locale.as_deref(), "panelMonitor"),
        label(locale.as_deref(), "hidePanel"),
        Some(dynamic(move || {
            badge(&live.stats.get(), locale.as_deref(), p)
        })),
        dynamic(move || body(&snapshot, &live.stats.get(), p)),
        p,
    )
}
