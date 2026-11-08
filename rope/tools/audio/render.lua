-- Run after a generated .rpp through reaper.sh. Export current track edits
-- as a separate 48 kHz mono, 24-bit WAV; never overwrite the candidate mix.
local _, project = reaper.EnumProjects(-1, "")
if project == "" then error("Open an audio candidate project first") end
local directory, name = project:match("^(.*)[/\\]([^/\\]+)%.rpp$")
if not directory then error("Save the project as an .rpp first") end
reaper.GetSetProjectInfo(0, "RENDER_SETTINGS", 0, true)
reaper.GetSetProjectInfo(0, "RENDER_BOUNDSFLAG", 0, true)
reaper.GetSetProjectInfo(0, "RENDER_STARTPOS", 0, true)
reaper.GetSetProjectInfo(0, "RENDER_ENDPOS", reaper.GetProjectLength(0), true)
reaper.GetSetProjectInfo(0, "RENDER_SRATE", 48000, true)
reaper.GetSetProjectInfo(0, "RENDER_CHANNELS", 1, true)
reaper.GetSetProjectInfo(0, "RENDER_TAILFLAG", 0, true)
reaper.GetSetProjectInfo_String(0, "RENDER_FILE", directory, true)
reaper.GetSetProjectInfo_String(0, "RENDER_PATTERN", name .. "-reaper", true)
reaper.GetSetProjectInfo_String(0, "RENDER_FORMAT", "ZXZhdxgAAA==", true)
reaper.Main_OnCommand(42230, 0) -- Render using current settings, auto-close dialog.
