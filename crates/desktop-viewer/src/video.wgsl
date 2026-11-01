struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
}

@vertex fn vertex(@builtin(vertex_index) index: u32) -> VertexOutput {
    let positions = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
    let p = positions[index];
    var out: VertexOutput;
    out.position = vec4f(p, 0., 1.);
    out.uv = vec2f((p.x + 1.) * 0.5, (1. - p.y) * 0.5);
    return out;
}

@group(0) @binding(0) var picture: texture_2d<f32>;
@group(0) @binding(1) var picture_sampler: sampler;

@fragment fn fragment(in: VertexOutput) -> @location(0) vec4f {
    return textureSample(picture, picture_sampler, in.uv);
}
