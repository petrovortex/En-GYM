# Render the app's SVG into a multi-resolution Windows icon without extra tools.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore,WindowsBase
$root = Split-Path $PSScriptRoot -Parent
[xml]$svg = Get-Content -Raw -LiteralPath (Join-Path $root 'public/en-gym.svg')
$mark = $svg.DocumentElement
$dpi = 96
$sizes = @(16,24,32,48,64,128,256)
$images = @()
foreach ($size in $sizes) {
  $visual = New-Object Windows.Media.DrawingVisual
  $drawing = $visual.RenderOpen()
  $drawing.PushTransform((New-Object Windows.Media.ScaleTransform ($size / 64), ($size / 64)))
  $brush = [Windows.Media.BrushConverter]::new()
  $rect = $mark.rect
  $drawing.DrawRoundedRectangle($brush.ConvertFromString($rect.fill), $null, [Windows.Rect]::new(0,0,64,64), 15, 15)
  foreach ($shape in $mark.g.path) {
    $color = $shape.GetAttribute('stroke')
    if (!$color) { $color = $mark.g.GetAttribute('stroke') }
    $pen = [Windows.Media.Pen]::new($brush.ConvertFromString($color), 3.6)
    $pen.LineJoin = 'Round'
    $pen.StartLineCap = $pen.EndLineCap = 'Round'
    $drawing.DrawGeometry($null, $pen, [Windows.Media.Geometry]::Parse($shape.d))
  }
  $drawing.Pop()
  $drawing.Close()
  $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new($size,$size,$dpi,$dpi,[Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($visual)
  $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
  $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $stream = [IO.MemoryStream]::new()
  $encoder.Save($stream)
  $images += ,$stream.ToArray()
  $stream.Dispose()
}
$dir = New-Item -ItemType Directory -Force -Path (Join-Path $root 'packaging')
$file = [IO.File]::Create((Join-Path $dir.FullName 'En-GYM.ico'))
$writer = [IO.BinaryWriter]::new($file)
try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
  $offset = 6 + 16 * $sizes.Count
  for ($i = 0; $i -lt $sizes.Count; $i++) {
    $width = [byte]($sizes[$i] % 256)
    $writer.Write($width); $writer.Write($width); $writer.Write([uint16]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$images[$i].Length); $writer.Write([uint32]$offset)
    $offset += $images[$i].Length
  }
  foreach ($image in $images) { $writer.Write([byte[]]$image) }
} finally { $writer.Dispose() }
