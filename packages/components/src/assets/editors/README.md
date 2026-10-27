# Editor icons

These icons identify installed applications in the Open with menu. Keep their
aspect ratios. Render VS Code and VSCodium in their original colors; render Zed
as a black/white mask to match the application theme.

| Asset | Official source | Attribution and usage |
| --- | --- | --- |
| `vscode.svg` | `visual-studio-code-icons/vscode.svg` from Microsoft's [icon archive](https://code.visualstudio.com/assets/branding/visual-studio-code-icons.zip) | Visual Studio Code and its icon are trademarks of Microsoft Corporation. The [usage guidelines](https://code.visualstudio.com/brand) provide this stable blue icon and describe Open in VS Code actions. Preserve its original colors. |
| `vscodium.svg` | VSCodium's [stable icon](https://github.com/VSCodium/vscodium/blob/master/icons/stable/codium_cnl.svg) | Copyright the VSCodium contributors, Peter Squicciarini, and Microsoft Corporation. Distributed under the upstream MIT license, reproduced in `VSCodium-LICENSE`. |
| `zed.svg` | The standalone logomark SVG from the [Zed brand page](https://zed.dev/brand) | Zed and its logos are trademarks of Zed Industries, Inc. The path is unchanged. The bundled SVG uses the permitted brand blue, `#1348DC`; its mask renders in permitted black or white for contrast in light and dark themes. |

Cursor uses the existing `@lobehub/icons-static-svg/icons/cursor.svg` dependency
(MIT), rendered as a mask that follows the menu text color. No additional icon
dependency is required.
