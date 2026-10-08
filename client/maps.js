import { config as C, radians } from '../shared/config.js';
export class IMapRenderer {
  render() {
    throw new Error('Implement render');
  }
  destroy() {}
}
export function meterMarkers(trajectory, spacing) {
  const markers = [];
  let next = spacing;
  for (let i = 1; i < trajectory.length; i++) {
    const a = trajectory[i - 1],
      b = trajectory[i];
    if (b.kind !== 'movement' || b.distance <= a.distance) continue;
    while (next <= b.distance) {
      if (next >= a.distance) {
        const k = (next - a.distance) / (b.distance - a.distance);
        markers.push({ x: a.x + k * (b.x - a.x), y: a.y + k * (b.y - a.y), distance: next });
      }
      next += spacing;
    }
  }
  return markers;
}
const transportColor = (c) =>
  c.runningTime >= Math.max(c.walkingTime, c.vehicleTime, c.standingTime)
    ? '#f0a34a'
    : c.vehicleTime >= Math.max(c.walkingTime, c.standingTime)
      ? '#8b6eed'
      : c.walkingTime >= c.standingTime
        ? '#23b69f'
        : '#e77362';
export function heatValue(c, mode) {
  return mode === 'speed' ? c.averageSpeed : mode === 'visits' ? c.visitCount : c.timeSpent;
}
export function fitTrajectory(points, width, height, padding = 48) {
  let minX = 0,
    maxX = 0,
    minY = 0,
    maxY = 0;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return {
    zoom: Math.max(
      0.001,
      Math.min(
        28,
        Math.max(1, width - 2 * padding) / Math.max(4, maxX - minX),
        Math.max(1, height - 2 * padding) / Math.max(4, maxY - minY),
      ),
    ),
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  };
}
export class LocalMapRenderer extends IMapRenderer {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.zoom = 28;
    this.pan = { x: 0, y: 0 };
    this.heat = 'off';
    this.follow = true;
    this.pointer = null;
    this.resizeObserver = new ResizeObserver(() => this.render(this.state));
    this.resizeObserver.observe(canvas);
    this.wheel = (e) => {
      if (this.follow) return;
      e.preventDefault();
      this.zoom = Math.max(2, Math.min(120, this.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
      this.render(this.state);
    };
    this.down = (e) => {
      if (this.follow) return;
      this.pointer = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };
    this.drag = (e) => {
      if (!this.pointer) return;
      this.pan.x += e.clientX - this.pointer.x;
      this.pan.y += e.clientY - this.pointer.y;
      this.pointer = { x: e.clientX, y: e.clientY };
      this.render(this.state);
    };
    this.up = () => (this.pointer = null);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    canvas.addEventListener('pointerdown', this.down);
    canvas.addEventListener('pointermove', this.drag);
    canvas.addEventListener('pointerup', this.up);
    canvas.addEventListener('pointercancel', this.up);
  }
  render(state) {
    this.state = state;
    if (!state) return;
    this.canvas.style.touchAction = this.follow ? 'pan-y' : 'none';
    const canvas = this.canvas,
      rect = canvas.getBoundingClientRect(),
      dpr = devicePixelRatio || 1,
      w = rect.width,
      h = rect.height;
    if (!w || !h) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#101d29';
    ctx.fillRect(0, 0, w, h);
    if (this.follow) {
      const fit = fitTrajectory([...state.trajectory, state], w, h);
      this.zoom = fit.zoom;
      this.pan = { x: -fit.x * this.zoom, y: fit.y * this.zoom };
    }
    const ox = w / 2 + this.pan.x,
      oy = h / 2 + this.pan.y;
    const project = (p) => ({ x: ox + p.x * this.zoom, y: oy - p.y * this.zoom });
    const spacing =
      this.zoom >= 18 ? 1 : this.zoom >= 5 ? 5 : 10 ** Math.ceil(Math.log10(45 / this.zoom));
    ctx.font = '10px system-ui';
    for (let axis = 0; axis < 2; axis++) {
      const extent = axis ? w : h,
        origin = axis ? ox : oy,
        limit = axis ? w : h;
      for (
        let i = Math.floor(-origin / (spacing * this.zoom));
        i < (limit - origin) / (spacing * this.zoom);
        i++
      ) {
        const p = origin + i * spacing * this.zoom;
        ctx.beginPath();
        ctx.strokeStyle = (i * spacing) % 5 === 0 ? '#28404d' : '#1a2c39';
        ctx.lineWidth = 0.6;
        if (axis) {
          ctx.moveTo(p, 0);
          ctx.lineTo(p, h);
        } else {
          ctx.moveTo(0, p);
          ctx.lineTo(w, p);
        }
        ctx.stroke();
        if ((i * spacing) % 10 === 0) {
          ctx.fillStyle = '#67818f';
          ctx.fillText(
            `${axis ? i * spacing : -i * spacing} m`,
            axis ? p + 4 : 7,
            axis ? h - 12 : p - 4,
          );
        }
      }
    }
    const cells = state.heatmap ?? [],
      max = Math.max(1, ...cells.map((c) => heatValue(c, this.heat)));
    if (this.heat !== 'off')
      for (const cell of cells) {
        const p = project({ x: cell.x, y: cell.y + C.cellSize });
        ctx.globalAlpha = 0.15 + (0.6 * heatValue(cell, this.heat)) / max;
        ctx.fillStyle =
          this.heat === 'transport'
            ? transportColor(cell)
            : this.heat === 'speed'
              ? '#edaa51'
              : '#25bea9';
        ctx.fillRect(p.x, p.y, C.cellSize * this.zoom, C.cellSize * this.zoom);
      }
    ctx.globalAlpha = 1;
    const trajectory = state.trajectory;
    ctx.lineWidth = 2.5;
    for (let i = 1; i < trajectory.length; i++) {
      const a = project(trajectory[i - 1]),
        b = project(trajectory[i]);
      ctx.strokeStyle = trajectory[i].kind === 'correction' ? '#e8ac61' : '#4bd1bc';
      ctx.setLineDash(trajectory[i].kind === 'correction' ? [3, 4] : []);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const marker of meterMarkers(trajectory, this.zoom >= 12 ? 5 : 20)) {
      const p = project(marker);
      ctx.beginPath();
      ctx.fillStyle = '#92e4d4';
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#d8eee9';
      ctx.fillText(`${marker.distance} m`, p.x + 7, p.y - 6);
    }
    const start = project({ x: 0, y: 0 });
    ctx.strokeStyle = '#a4b7bf';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(start.x, start.y, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#b0c5ce';
    ctx.fillText('START', start.x + 10, start.y + 4);
    const current = project(state);
    if (Number.isFinite(state.deviceHeading)) {
      ctx.save();
      ctx.translate(current.x, current.y);
      ctx.rotate(radians(state.deviceHeading));
      ctx.strokeStyle = '#e8ac61';
      ctx.lineWidth = 2;
      ctx.strokeRect(-6, -31, 12, 19);
      ctx.beginPath();
      ctx.moveTo(0, -35);
      ctx.lineTo(0, -43);
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(current.x, current.y);
    ctx.fillStyle = '#36c6ad22';
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(radians(state.deviceHeading ?? state.heading));
    ctx.fillStyle = '#56e2c9';
    ctx.strokeStyle = '#d5fff6';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(9, 10);
    ctx.lineTo(0, 6);
    ctx.lineTo(-9, 10);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    const scale = spacing * 5;
    ctx.strokeStyle = '#b3c8d0';
    ctx.beginPath();
    ctx.moveTo(w - 30 - scale * this.zoom, h - 35);
    ctx.lineTo(w - 30, h - 35);
    ctx.stroke();
    ctx.fillStyle = '#acc1ca';
    ctx.fillText(`${scale} m`, w - 30 - scale * this.zoom, h - 43);
  }
  destroy() {
    this.resizeObserver.disconnect();
    const c = this.canvas;
    c.removeEventListener('wheel', this.wheel);
    c.removeEventListener('pointerdown', this.down);
    c.removeEventListener('pointermove', this.drag);
    c.removeEventListener('pointerup', this.up);
    c.removeEventListener('pointercancel', this.up);
  }
}
export class GoogleMapsRenderer extends IMapRenderer {
  constructor(element) {
    super();
    this.element = element;
    this.overlays = [];
    this.heat = 'off';
  }
  async initialize(key) {
    if (!key) throw new Error('Ange en Google Maps API-nyckel.');
    if (!globalThis.google?.maps) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&loading=async&callback=qsysGoogleReady`;
        globalThis.qsysGoogleReady = resolve;
        globalThis.gm_authFailure = () => reject(new Error('Google Maps behörighetsfel'));
        script.onerror = () => reject(new Error('Google Maps kunde inte laddas'));
        document.head.append(script);
        setTimeout(() => reject(new Error('Google Maps timeout')), 12000);
      });
    }
    this.map = new google.maps.Map(this.element, {
      center: { lat: 59.3293, lng: 18.0686 },
      zoom: 19,
      mapTypeId: 'roadmap',
      disableDefaultUI: true,
      zoomControl: true,
    });
  }
  render(s) {
    if (!this.map || !s.origin || s.geographicHeading === null)
      throw new Error('Google Maps behöver ett GPS-ankare med tillförlitlig färdriktning.');
    for (const o of this.overlays) o.setMap(null);
    this.overlays = [];
    const geo = (p) => {
      const x = p.x - (s.originLocal?.x ?? 0),
        y = p.y - (s.originLocal?.y ?? 0),
        r = globalThis.geodesic.Geodesic.WGS84.Direct(
          s.origin.latitude,
          s.origin.longitude,
          s.geographicHeading + (Math.atan2(x, y) * 180) / Math.PI,
          Math.hypot(x, y),
        );
      return { lat: r.lat2, lng: r.lon2 };
    };
    const add = (x) => {
      this.overlays.push(x);
      return x;
    };
    const position = geo(s);
    const bounds = new google.maps.LatLngBounds();
    for (const p of s.trajectory) bounds.extend(geo(p));
    bounds.extend(position);
    if (this.follow !== false) {
      this.map.fitBounds(bounds, 48);
      if (this.map.getZoom() > 20) this.map.setZoom(20);
    }
    add(
      new google.maps.Polyline({
        map: this.map,
        path: s.trajectory.map(geo),
        strokeColor: '#159c85',
        strokeWeight: 4,
      }),
    );
    add(
      new google.maps.Marker({
        map: this.map,
        position: geo({ x: 0, y: 0 }),
        label: 'S',
        title: 'Start',
      }),
    );
    add(
      new google.maps.Marker({
        map: this.map,
        position,
        icon: {
          path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
          scale: 6,
          rotation: s.geographicHeading + (s.deviceHeading ?? s.heading),
          fillColor: '#14b89b',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
      }),
    );
    for (const p of meterMarkers(s.trajectory, 10))
      add(
        new google.maps.Marker({
          map: this.map,
          position: geo(p),
          label: `${p.distance}`,
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 3, strokeColor: '#169d85' },
        }),
      );
    if (s.gps.latitude !== undefined) {
      add(
        new google.maps.Circle({
          map: this.map,
          center: { lat: s.gps.latitude, lng: s.gps.longitude },
          radius: s.gps.accuracy,
          strokeColor: '#e8a248',
          fillColor: '#e8a248',
          fillOpacity: 0.1,
        }),
      );
      add(
        new google.maps.Marker({
          map: this.map,
          position: { lat: s.gps.latitude, lng: s.gps.longitude },
          label: 'G',
          title: 'Rå GPS',
        }),
      );
    }
    if (s.predictedPosition)
      add(
        new google.maps.Marker({
          map: this.map,
          position: geo(s.predictedPosition),
          label: 'P',
          title: 'Predikterad PDR',
        }),
      );
    const max = Math.max(1, ...s.heatmap.map((c) => heatValue(c, this.heat)));
    if (this.heat !== 'off')
      for (const c of s.heatmap) {
        const a = geo(c),
          b = geo({ x: c.x + C.cellSize, y: c.y + C.cellSize });
        add(
          new google.maps.Rectangle({
            map: this.map,
            bounds: {
              north: Math.max(a.lat, b.lat),
              south: Math.min(a.lat, b.lat),
              east: Math.max(a.lng, b.lng),
              west: Math.min(a.lng, b.lng),
            },
            strokeWeight: 0,
            fillColor: this.heat === 'transport' ? transportColor(c) : '#e8a248',
            fillOpacity: 0.15 + (0.6 * heatValue(c, this.heat)) / max,
          }),
        );
      }
  }
  destroy() {
    for (const o of this.overlays) o.setMap(null);
    this.overlays = [];
    this.element.replaceChildren();
  }
}
