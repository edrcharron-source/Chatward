import { useEffect, useState } from 'react';
import Cropper, { type Area } from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';

/** Drag-and-zoom crop box shared by the avatar and banner editors. */
export default function ImageCropper({ source, aspect, round = false, onArea }: {
  source: string;
  aspect: number;
  round?: boolean;
  onArea: (area: Area | null) => void;
}) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);

  // A new picture starts centred and unzoomed.
  useEffect(() => {
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    onArea(null);
  }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="crop-box">
      <div className={round ? 'avatar-crop' : 'banner-crop'}>
        <Cropper
          image={source}
          crop={crop}
          zoom={zoom}
          aspect={aspect}
          cropShape={round ? 'round' : 'rect'}
          showGrid={false}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={(_, px) => onArea(px)}
        />
      </div>
      <label className="setting-row">
        <span className="setting-text"><span>Zoom</span></span>
        <input type="range" min={1} max={3} step={0.01} value={zoom} aria-label="Zoom"
          onChange={(e) => setZoom(Number(e.target.value))} />
      </label>
    </div>
  );
}
