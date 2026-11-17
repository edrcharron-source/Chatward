// A stand-in screen share for demo mode's call preview (state/voicePreview.ts): a slowly moving scene drawn on a canvas.
// Made once and kept, since the demo has no real sharer to stop it.

let stream: MediaStream | null = null;

export function demoPreviewShare(): MediaStream {
  if (stream) return stream;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const g = canvas.getContext('2d')!;
  let t = 0;
  const draw = () => {
    t += 1;
    const sky = g.createLinearGradient(0, 0, 0, 180);
    sky.addColorStop(0, `hsl(${(210 + t) % 360} 60% 35%)`);
    sky.addColorStop(1, `hsl(${(170 + t) % 360} 55% 55%)`);
    g.fillStyle = sky;
    g.fillRect(0, 0, 320, 180);
    g.fillStyle = '#ffd877';
    g.beginPath();
    g.arc(40 + ((t * 3) % 260), 40, 18, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3f6f8a';
    g.beginPath();
    g.moveTo(0, 130); g.lineTo(80, 70); g.lineTo(170, 130); g.lineTo(250, 60); g.lineTo(320, 130);
    g.fill();
    g.fillStyle = '#3c9a4c';
    g.fillRect(0, 125, 320, 55);
    g.fillStyle = '#d0453c';
    g.fillRect(140 + Math.sin(t / 4) * 60, 100, 18, 26);
  };
  draw();
  setInterval(draw, 250);
  stream = canvas.captureStream(4);
  return stream;
}
