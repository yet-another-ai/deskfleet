//! Android GPU drawing is independent of frame selection.

use ndk::native_window::NativeWindow;

use crate::{Error, Frame};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PhysicalSize<T> {
    pub(crate) width: T,
    pub(crate) height: T,
}

impl<T> PhysicalSize<T> {
    pub(crate) const fn new(width: T, height: T) -> Self {
        Self { width, height }
    }
}

pub(crate) struct Renderer {
    instance: wgpu::Instance,
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    sampler: wgpu::Sampler,
    image: Option<(wgpu::Texture, wgpu::BindGroup)>,
    window: NativeWindow,
    pub(crate) video_size: (u32, u32),
}

#[derive(Clone, Debug)]
struct AndroidSurfaceWindow(NativeWindow);

impl wgpu::rwh::HasWindowHandle for AndroidSurfaceWindow {
    fn window_handle(&self) -> Result<wgpu::rwh::WindowHandle<'_>, wgpu::rwh::HandleError> {
        self.0.window_handle()
    }
}

impl wgpu::rwh::HasDisplayHandle for AndroidSurfaceWindow {
    fn display_handle(&self) -> Result<wgpu::rwh::DisplayHandle<'_>, wgpu::rwh::HandleError> {
        Ok(wgpu::rwh::DisplayHandle::android())
    }
}

impl Renderer {
    pub(crate) async fn new(window: NativeWindow, size: PhysicalSize<u32>) -> Result<Self, Error> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let surface = instance.create_surface(AndroidSurfaceWindow(window.clone()))?;
        Self::init(instance, surface, window, size).await
    }

    async fn init(
        instance: wgpu::Instance,
        surface: wgpu::Surface<'static>,
        window: NativeWindow,
        size: PhysicalSize<u32>,
    ) -> Result<Self, Error> {
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                compatible_surface: Some(&surface),
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("desktop viewer"),
                ..Default::default()
            })
            .await?;
        let mut config = surface
            .get_default_config(&adapter, size.width.max(1), size.height.max(1))
            .ok_or("no compatible window surface")?;
        config.present_mode = wgpu::PresentMode::Fifo;
        config.desired_maximum_frame_latency = 1;
        config.format = surface
            .get_capabilities(&adapter)
            .formats
            .into_iter()
            .find(wgpu::TextureFormat::is_srgb)
            .unwrap_or(config.format);
        surface.configure(&device, &config);
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("desktop pixels"),
            source: wgpu::ShaderSource::Wgsl(include_str!("video.wgsl").into()),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("desktop video"),
            layout: None,
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vertex"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fragment"),
                compilation_options: Default::default(),
                targets: &[Some(config.format.into())],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("desktop scale"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        tracing::info!(adapter = ?adapter.get_info(), "native viewer GPU");
        Ok(Self {
            instance,
            surface,
            device,
            queue,
            config,
            pipeline,
            sampler,
            image: None,
            window,
            video_size: (0, 0),
        })
    }

    pub(crate) fn resize(&mut self, size: PhysicalSize<u32>) {
        if size.width == 0 || size.height == 0 {
            return;
        }
        self.config.width = size.width;
        self.config.height = size.height;
        self.surface.configure(&self.device, &self.config);
    }

    pub(crate) fn surface_size(&self) -> PhysicalSize<u32> {
        PhysicalSize::new(self.config.width, self.config.height)
    }

    fn current_size(&self) -> PhysicalSize<u32> {
        let width = u32::try_from(self.window.width().max(0)).unwrap_or(self.config.width);
        let height = u32::try_from(self.window.height().max(0)).unwrap_or(self.config.height);
        PhysicalSize::new(
            if width > 0 { width } else { self.config.width },
            if height > 0 {
                height
            } else {
                self.config.height
            },
        )
    }

    pub(crate) fn acquire(&mut self) -> Result<Option<wgpu::SurfaceTexture>, Error> {
        use wgpu::CurrentSurfaceTexture as Current;
        match self.surface.get_current_texture() {
            Current::Success(texture) | Current::Suboptimal(texture) => Ok(Some(texture)),
            Current::Timeout | Current::Occluded => Ok(None),
            Current::Outdated => {
                self.resize(self.current_size());
                Ok(None)
            }
            Current::Lost => {
                self.surface = self
                    .instance
                    .create_surface(AndroidSurfaceWindow(self.window.clone()))?;
                self.resize(self.current_size());
                Ok(None)
            }
            Current::Validation => Err("GPU surface validation failed".into()),
        }
    }

    pub(crate) fn upload(&mut self, frame: &Frame) -> Result<(), Error> {
        let (width, height) = (frame.width, frame.height);
        let limit = self.device.limits().max_texture_dimension_2d;
        if width == 0
            || height == 0
            || width > limit
            || height > limit
            || u64::from(width) * u64::from(height) * 4 != frame.pixels.len() as u64
        {
            return Err("decoded frame has unsupported dimensions or pixel layout".into());
        }
        if self.video_size != (width, height) {
            let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("decoded desktop"),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            let view = texture.create_view(&Default::default());
            let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("desktop image"),
                layout: &self.pipeline.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.sampler),
                    },
                ],
            });
            self.image = Some((texture, bind_group));
            self.video_size = (width, height);
        }
        if let Some((texture, _)) = &self.image {
            self.queue.write_texture(
                texture.as_image_copy(),
                &frame.pixels,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(width * 4),
                    rows_per_image: Some(height),
                },
                wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
            );
        }
        Ok(())
    }

    pub(crate) fn upload_next(
        &mut self,
        frames: &crate::session::Frames,
        submitted: &mut u64,
        last_ready_age_ms: &mut f64,
    ) -> Result<(), Error> {
        let frame = frames.lock().map_err(|_| "decoded queue poisoned")?.pop();
        if let Some(frame) = frame {
            self.upload(&frame)?;
            *last_ready_age_ms = frame.ready_at.elapsed().as_secs_f64() * 1000.;
            *submitted += 1;
        }
        Ok(())
    }

    pub(crate) fn draw(&self, output: wgpu::SurfaceTexture) -> Result<(), Error> {
        let view = output.texture.create_view(&Default::default());
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("desktop present"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            if let Some((_, image)) = &self.image {
                let (x, y, width, height) = viewport(self.current_size(), self.video_size);
                pass.set_viewport(x as f32, y as f32, width as f32, height as f32, 0., 1.);
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, image, &[]);
                pass.draw(0..3, 0..1);
            }
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(output);
        Ok(())
    }
}

pub(crate) fn viewport(size: PhysicalSize<u32>, video: (u32, u32)) -> (f64, f64, f64, f64) {
    let width = f64::from(size.width);
    let height = f64::from(size.height);
    if video.0 == 0 || video.1 == 0 {
        return (0., 0., width, height);
    }
    let scale = (width / f64::from(video.0)).min(height / f64::from(video.1));
    let (w, h) = (f64::from(video.0) * scale, f64::from(video.1) * scale);
    ((width - w) / 2., (height - h) / 2., w, h)
}
