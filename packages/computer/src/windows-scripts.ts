import { NATIVE_CSHARP } from './windows-native';

/**
 * PowerShell programs for the Windows adapter. Each is a constant. Data reaches a script only through the
 * `ALLAYA_ARGS` environment variable (JSON), so text from the user or the model can never become code.
 */
const PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$a = $null
if ($env:ALLAYA_ARGS) { $a = $env:ALLAYA_ARGS | ConvertFrom-Json }
function Done($value) { [Console]::Out.Write(($value | ConvertTo-Json -Compress -Depth 6)); exit 0 }
`;

const NATIVE = String.raw`
Add-Type -TypeDefinition @'
${NATIVE_CSHARP}
'@
[Allaya.Native]::EnableDpiAwareness()
`;

export const SCRIPTS = {
  listWindows:
    PRELUDE +
    NATIVE +
    String.raw`
$names = @{}
Get-Process | ForEach-Object { $names[[uint32]$_.Id] = $_.ProcessName }
$out = @()
foreach ($w in [Allaya.Native]::ListWindows()) {
  $name = if ($names.ContainsKey($w.Pid)) { $names[$w.Pid] } else { '' }
  $out += [pscustomobject]@{
    id = [string]$w.Handle; title = $w.Title; processName = $name.ToLowerInvariant(); pid = [int]$w.Pid
    x = $w.X; y = $w.Y; width = $w.W; height = $w.H
    minimized = [bool]$w.Iconic; focused = [bool]$w.Focused; elevated = [bool]$w.Elevated
  }
}
Done @{ windows = @($out) }
`,

  focusWindow:
    PRELUDE +
    NATIVE +
    String.raw`
$ok = [Allaya.Native]::Focus([long]$a.id)
Done @{ ok = [bool]$ok }
`,

  closeWindow:
    PRELUDE +
    NATIVE +
    String.raw`
$ok = [Allaya.Native]::Close([long]$a.id)
Done @{ ok = [bool]$ok }
`,

  launch:
    PRELUDE +
    String.raw`
$params = @{ FilePath = [string]$a.executable; PassThru = $true }
if ($a.arguments -and @($a.arguments).Count -gt 0) { $params['ArgumentList'] = @($a.arguments | ForEach-Object { [string]$_ }) }
$p = Start-Process @params
Done @{ pid = if ($p) { [int]$p.Id } else { $null } }
`,

  moveMouse:
    PRELUDE +
    NATIVE +
    String.raw`
[Allaya.Native]::Move([int]$a.x, [int]$a.y)
Done @{ ok = $true }
`,

  clickMouse:
    PRELUDE +
    NATIVE +
    String.raw`
[Allaya.Native]::Click([int]$a.x, [int]$a.y, [string]$a.button, [int]$a.count)
Done @{ ok = $true }
`,

  scroll:
    PRELUDE +
    NATIVE +
    String.raw`
[Allaya.Native]::Scroll([int]$a.delta)
Done @{ ok = $true }
`,

  typeText:
    PRELUDE +
    NATIVE +
    String.raw`
[Allaya.Native]::TypeText([string]$a.text)
Done @{ ok = $true }
`,

  pressKeys:
    PRELUDE +
    NATIVE +
    String.raw`
[Allaya.Native]::Chord([int[]]@($a.modifiers), [int]$a.key)
Done @{ ok = $true }
`,

  invokeElement:
    PRELUDE +
    String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$root = $AE::FromHandle([IntPtr]::new([long]$a.windowId))
$flags = [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, [string]$a.name, $flags)
if ($a.controlType) {
  $types = @{
    button = [System.Windows.Automation.ControlType]::Button; menuitem = [System.Windows.Automation.ControlType]::MenuItem
    checkbox = [System.Windows.Automation.ControlType]::CheckBox; radiobutton = [System.Windows.Automation.ControlType]::RadioButton
    tab = [System.Windows.Automation.ControlType]::TabItem; link = [System.Windows.Automation.ControlType]::Hyperlink
    listitem = [System.Windows.Automation.ControlType]::ListItem; edit = [System.Windows.Automation.ControlType]::Edit
  }
  $typeCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $types[[string]$a.controlType])
  $cond = New-Object System.Windows.Automation.AndCondition($cond, $typeCond)
}
$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
if (-not $el) { Done @{ found = $false } }
$pattern = $null
if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); Done @{ found = $true } }
if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $pattern.Toggle(); Done @{ found = $true } }
if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $pattern.Select(); Done @{ found = $true } }
if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) { $pattern.Expand(); Done @{ found = $true } }
Done @{ found = $true; acted = $false }
`,
} as const;

export type ScriptName = keyof typeof SCRIPTS;
