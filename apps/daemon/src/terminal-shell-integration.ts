import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Let zsh load its normal startup files, then restore the terminal's helper PATH. */
export async function zshImageEnvironment(historyDirectory: string): Promise<Record<string, string>> {
  const bin = join(historyDirectory, ".shell-bin")
  const directory = join(bin, ".zsh")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // Zsh reads these in its normal order, interleaved with the system startup files.
  // Each wrapper exposes the real ZDOTDIR while sourcing user configuration, and
  // carries any changes to that directory forward to the next startup file.
  for (const [file, moreFiles] of [
    [".zshenv", "[[ -o login || -o interactive ]]"],
    [".zprofile", "[[ -o login ]]"],
    [".zshrc", "[[ -o login ]]"],
    [".zlogin", "false"],
  ] as const) {
    const restore = file === ".zshenv" ? `
if (( \${+DESKFLEET_ORIGINAL_ZDOTDIR} )); then
  ZDOTDIR=$DESKFLEET_ORIGINAL_ZDOTDIR
else
  unset ZDOTDIR
fi
unset DESKFLEET_ORIGINAL_ZDOTDIR
` : `
if (( _deskfleet_zdotdir_set )); then
  ZDOTDIR=$_deskfleet_zdotdir
else
  unset ZDOTDIR
fi
`
    const script = `${restore}
if [[ -r "\${ZDOTDIR-$HOME}/${file}" ]]; then
  source "\${ZDOTDIR-$HOME}/${file}"
fi
if [[ -o rcs ]] && ${moreFiles}; then
  _deskfleet_zdotdir_set=\${+ZDOTDIR}
  _deskfleet_zdotdir=\${ZDOTDIR-}
  export ZDOTDIR=${shellQuote(directory)}
else
  # macOS startup can move the inherited helper behind system directories.
  # Move only this exact entry to the front, preserving the rest of PATH.
  _deskfleet_path=(${shellQuote(bin)})
  for _deskfleet_entry in "\${path[@]}"; do
    if [[ $_deskfleet_entry != ${shellQuote(bin)} ]]; then
      _deskfleet_path+=("$_deskfleet_entry")
    fi
  done
  path=("\${_deskfleet_path[@]}")
  export PATH
  unset _deskfleet_zdotdir _deskfleet_zdotdir_set _deskfleet_path _deskfleet_entry
fi
`
    await writeFile(join(directory, file), script, { mode: 0o600 })
  }
  return {
    ...(process.env.ZDOTDIR !== undefined ? { DESKFLEET_ORIGINAL_ZDOTDIR: process.env.ZDOTDIR } : {}),
    ZDOTDIR: directory,
  }
}
