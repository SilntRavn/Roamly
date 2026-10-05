import { useEffect, useRef, useState } from "react";
import { Trees, Utensils, BedDouble, Gamepad2, MapPin, ArrowLeft, ChevronUp, ChevronDown, Send, RefreshCw, LoaderCircle, BookOpen, ExternalLink, Heart } from "lucide-react";
import MapView from "./MapView";
import { api, post } from "./api";
import { Back, IconButton, Photo } from "./components";
import { MotionTabs } from "./motion";
import { createExploreViewCache, readExploreState, writeExploreState } from "./explore-cache.mjs";
import { startAccountSync } from "./account-sync.mjs";
import { rankExploreNotes, rankExplorePlaces, explorePage } from "./explore-feed-order.mjs";
import { exploreCategories, exploreDistance, insideExploreBounds, snapExploreSheet, exploreSearchArea, shouldReloadExplore } from "../shared/explore.mjs";
import type { ExploreArea, ExploreSearchArea, ExploreCategory, ExploreFeed, ExploreNote, Place } from "./types";
import "./explore.css";

const icons = { scenery: Trees, food: Utensils, stay: BedDouble, fun: Gamepad2 };
// 保留离开探索页前的区域、分类与面板位置；不读取当前行程。
const radius = 10000;
let storage: Storage | undefined;
try {
  storage = window.localStorage;
  for (const key of ["roamly-explore-views-v2", "roamly-explore-state-v1"]) {
    const previous = window.sessionStorage.getItem(key);
    if (!storage.getItem(key) && previous) storage.setItem(key, previous);
  }
} catch { try { storage = window.sessionStorage; } catch {} }
let saved: { category: ExploreCategory; area: ExploreArea | null; search: ExploreSearchArea | null; sheet: number; scroll: number } = readExploreState(storage, { category: "scenery", area: null, search: null, sheet: 1, scroll: 0 });
const viewCache = createExploreViewCache(storage);
type ExploreResult = { places: Place[]; feed: ExploreFeed };
const areaKey = (area: ExploreSearchArea, category: ExploreCategory) => [category, area.lng.toFixed(5), area.lat.toFixed(5), area.radius].join(":");
const distanceText = (place: Place, area: ExploreSearchArea | null) => {
  if (!area) return place.district || place.city;
  const distance = exploreDistance(place, area);
  return `${distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(1)} km`} · ${place.district || place.city}`;
};
const shortDate = (date: string) => new Date(date).toLocaleDateString("zh-CN", { month: "long", day: "numeric", timeZone: "Asia/Shanghai" });
type Presentation = { key: string; seed: number; noteLimit: number; placeLimit: number; noteIds: string[]; placeIds: string[] };
const presentations = new Map<string, Presentation>();
function presentationFor(key: string): Presentation {
  if (!presentations.has(key)) {
    presentations.set(key, { key, seed: Math.floor(Math.random() * 0xffffffff), noteLimit: 6, placeLimit: 10, noteIds: [], placeIds: [] });
    if (presentations.size > 12) presentations.delete(presentations.keys().next().value!);
  }
  return presentations.get(key)!;
}

export default function ExplorePage({ path, onOpenNote, onBackFromNote, favoriteNoteIds, pendingNoteIds, onFavoriteNote, onOpenPlace, onAddPlace, onPlaces }: {
  path: string; onOpenNote: (id: string) => void; onBackFromNote: () => void;
  favoriteNoteIds: string[]; pendingNoteIds: string[]; onFavoriteNote: (note: ExploreNote) => void; onOpenPlace: (place: Place) => void;
  onAddPlace: (place: Place) => void; onPlaces: (places: Place[]) => void;
}) {
  const [category, setCategory] = useState<ExploreCategory>(saved.category);
  const [area, setArea] = useState<ExploreArea | null>(saved.area);
  const [search, setSearch] = useState<ExploreSearchArea | null>(saved.search);
  const [sheet, setSheet] = useState(saved.sheet);
  const initial = saved.search ? viewCache.get(areaKey(saved.search, saved.category)) as ExploreResult | undefined : undefined;
  const [places, setPlaces] = useState<Place[]>(initial?.places || []);
  const [feed, setFeed] = useState<ExploreFeed | null>(initial?.feed || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [focused, setFocused] = useState<Place | null>(null);
  const [revision, setRevision] = useState(0);
  const viewKey = search ? areaKey(search, category) : category;
  const [presentation, setPresentation] = useState(() => presentationFor(viewKey));
  const page = presentation.key === viewKey ? presentation : presentationFor(viewKey);
  const [newNoteCount, setNewNoteCount] = useState(0);
  const initialView = useRef(saved.area ? { lng: saved.area.cameraLng ?? saved.area.lng, lat: saved.area.cameraLat ?? saved.area.lat, zoom: saved.area.zoom } : undefined);
  const noteId = path.startsWith("/explore/notes/") ? decodeURIComponent(path.split("/")[3]) : null;
  const panel = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; time: number; delta: number } | null>(null);
  const touch = useRef<{ y: number; top: number } | null>(null);
  const callbacks = useRef({ onPlaces });
  callbacks.current = { onPlaces };
  useEffect(() => { saved = { ...saved, category, area, search, sheet }; writeExploreState(storage, saved); }, [category, area, search, sheet]);
  useEffect(() => {
    if (!area || noteId) return;
    setSearch((previous) => previous?.radius !== radius || shouldReloadExplore(area, previous) ? exploreSearchArea(area, radius) : previous);
  }, [area?.lng, area?.lat, area?.zoom, Boolean(noteId)]);
  useEffect(() => { if (list.current) list.current.scrollTop = saved.scroll; }, []);
  useEffect(() => {
    if (!search || noteId) return;
    const controller = new AbortController();
    let timer = 0;
    let active = true;
    const key = areaKey(search, category);
    const warm = viewCache.get(key) as ExploreResult | undefined;
    setFocused(null);
    setError("");
    setPlaces((previous) => warm?.places || previous.filter((place) => insideExploreBounds(place, search)));
    setFeed((previous) => warm?.feed || (previous?.notes.some((note) => note.category === category && note.placeIds.some((id) => {
      const place = previous.places.find((place) => place.id === id);
      return place && insideExploreBounds(place, search);
    })) ? previous : null));
    const params = { ...search, category };
    const accept = (result: ExploreResult) => {
      if (!active) return;
      setPlaces(result.places);
      setFeed(result.feed);
      callbacks.current.onPlaces([...result.places, ...result.feed.places]);
      viewCache.set(key, result);
      setBusy(false);
      if (result.feed.status === "loading" && result.feed.key) timer = window.setTimeout(async () => {
        try {
          const updated = await api<ExploreFeed>(`/explore/feeds/${encodeURIComponent(result.feed.key!)}`, { signal: controller.signal });
          accept({ places: result.places, feed: updated });
        } catch (e) { fail(e, result); }
      }, 2500);
      else if (result.feed.status === "waiting") timer = window.setTimeout(() => void load(), 4500);
    };
    const fail = (error: unknown, previous?: ExploreResult) => {
      if (!active || controller.signal.aborted) return;
      const kept = previous || viewCache.get(key) as ExploreResult | undefined;
      const notes = kept?.feed.notes || (feed?.notes || []).filter((note) => note.category === category && note.placeIds.some((id) => {
        const place = feed?.places.find((place) => place.id === id);
        return place && insideExploreBounds(place, search);
      }));
      accept({ places: kept?.places || [], feed: { ...(kept?.feed || { key: null }), status: "error", message: "", notes, places: kept?.feed.places || feed?.places || [] } });
      setError((error as Error).message);
    };
    const load = async () => {
      setBusy(true);
      try {
        const result = await api<ExploreResult>(`/explore/nearby?${new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))}`, { signal: controller.signal });
        accept(result);
      } catch (e) { fail(e); }
    };
    // Cached terminal feeds are already persisted; only unfinished jobs resume polling.
    if (warm) accept(warm);
    else void load();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [search, category, revision, Boolean(noteId)]);

  useEffect(() => {
    if (!search || noteId) return;
    const key = areaKey(search, category);
    const params = new URLSearchParams(Object.entries({ ...search, category }).map(([key, value]) => [key, String(value)]));
    let active = true;
    const stop = startAccountSync({ window, document, intervalMs: 15000, refresh: async (signal: AbortSignal) => {
      const result = await api<ExploreResult | null>(`/explore/stored?${params}`, { signal });
      if (!active || signal.aborted || !result) return;
      const before = viewCache.get(key) as ExploreResult | undefined;
      const ids = new Set(before?.feed.notes.map((note) => note.id));
      const added = before ? result.feed.notes.filter((note) => !ids.has(note.id)).length : 0;
      if (added) setNewNoteCount((count) => count + added);
      // Synchronizing the shared library never starts generation or clears existing cards.
      if (!before || JSON.stringify(before) !== JSON.stringify(result)) {
        viewCache.set(key, result);
        setPlaces(result.places); setFeed(result.feed);
        callbacks.current.onPlaces([...result.places, ...result.feed.places]);
      }
    } });
    return () => { active = false; stop(); };
  }, [viewKey, Boolean(noteId), favoriteNoteIds.join(",")]);

  useEffect(() => { setNewNoteCount(0); }, [viewKey]);

  const refresh = async () => {
    if (!area || busy || feed?.status === "loading") return;
    setBusy(true);
    setError("");
    const target = search || exploreSearchArea(area, radius);
    try {
      const result = await post<ExploreResult>("/explore/refresh", { ...target, category });
      viewCache.set(areaKey(target, category), result);
      setSearch(target);
      setRevision((n) => n + 1);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const visibleNotes = (feed?.notes || []).filter((note) => note.category === category && (!search || note.placeIds.some((id) => {
    const place = feed?.places.find((p) => p.id === id);
    return place && insideExploreBounds(place, search);
  })));
  const recommendedIds = new Set(visibleNotes.flatMap((note) => note.placeIds));
  const nearby = (category === "scenery" ? (feed?.places || []).filter((place) => recommendedIds.has(place.id)) : [...places])
    .filter((place) => !search || insideExploreBounds(place, search));
  // Read dynamic ratings from the public-place response while keeping article snapshots complete.
  const currentPlaces = new Map(places.map((place) => [place.id, place]));
  const orderedNotes = rankExploreNotes(visibleNotes, page.seed, page.noteIds) as ExploreNote[];
  const orderedPlaces = rankExplorePlaces(nearby.map((place) => currentPlaces.get(place.id) || place), page.placeIds,
    (place: Place) => search ? exploreDistance(place, search) : 0) as Place[];
  const notePage = explorePage(orderedNotes, page.noteLimit, 4);
  const placePage = explorePage(orderedPlaces, page.placeLimit, 10);
  const displayedNotes = notePage.items as ExploreNote[];
  const displayedPlaces = placePage.items as Place[];
  const noteIds = displayedNotes.map((note) => note.id).join(",");
  const placeIds = displayedPlaces.map((place) => place.id).join(",");
  useEffect(() => {
    const next = { ...page, noteIds: noteIds ? noteIds.split(",") : page.noteIds, placeIds: placeIds ? placeIds.split(",") : page.placeIds };
    presentations.set(viewKey, next);
    setPresentation((previous) => previous.key === next.key && previous.noteIds.join(",") === next.noteIds.join(",") && previous.placeIds.join(",") === next.placeIds.join(",") ? previous : next);
  }, [viewKey, noteIds, placeIds]);
  const expand = (kind: "notes" | "places") => {
    const next = { ...page, ...(kind === "notes" ? { noteLimit: notePage.nextLimit } : { placeLimit: placePage.nextLimit }) };
    presentations.set(viewKey, next); setPresentation(next);
    if (kind === "notes") setNewNoteCount(0);
  };
  const CategoryIcon = icons[category];
  const chooseCategory = (next: ExploreCategory) => {
    if (next === category) return;
    const warm = search ? viewCache.get(areaKey(search, next)) as ExploreResult | undefined : undefined;
    setCategory(next); setFocused(null); setPlaces(warm?.places || []); setFeed(warm?.feed || null);
    setBusy(Boolean(search) && !warm);
    saved.scroll = 0;
    if (list.current) list.current.scrollTop = 0;
  };
  return <>
    <div className={`explore-page nearby-explore ${noteId ? "explore-hidden" : ""}`} data-category={category}>
      <MapView places={places} exploreCategory={category} initialView={initialView.current}
        onAreaChange={setArea} onSelect={setFocused} focusId={focused?.id} onDeselect={() => setFocused(null)} onOpenPlace={onOpenPlace} />
      <header className="explore-toolbar" data-map-obstacle="top">
        <MotionTabs className="segmented explore-category-tabs" value={category} role="tablist" aria-label="探索地点分类">
          {(Object.keys(exploreCategories) as ExploreCategory[]).map((key) => {
            const Icon = icons[key];
            return <button key={key} className={key === category ? "selected" : ""} role="tab" aria-selected={key === category} aria-controls="explore-recommendations" onClick={() => chooseCategory(key)}><Icon size={19} /><span>{exploreCategories[key].label}</span></button>;
          })}
        </MotionTabs>
      </header>
      <section ref={panel} id="explore-recommendations" role="tabpanel" aria-label={`附近${exploreCategories[category].label}笔记`}
        className={`explore-notes-sheet sheet-state-${sheet}`} data-map-obstacle="bottom">
        <button className="sheet-handle explore-sheet-handle" aria-label={sheet === 2 ? "收起推荐笔记" : "展开推荐笔记"} onClick={() => {
          if (drag.current && Math.abs(drag.current.delta) > 4) { drag.current = null; return; }
          setSheet(sheet === 2 ? 1 : sheet + 1);
        }} onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { y: event.clientY, time: performance.now(), delta: 0 };
        }} onPointerMove={(event) => {
          if (!drag.current) return;
          drag.current.delta = event.clientY - drag.current.y;
          panel.current?.style.setProperty("--sheet-drag", `${drag.current.delta * .65}px`);
        }} onPointerUp={() => {
          if (!drag.current) return;
          const delta = drag.current.delta;
          setSheet(snapExploreSheet(sheet, delta, delta / Math.max(1, performance.now() - drag.current.time)));
          panel.current?.style.removeProperty("--sheet-drag");
          // 保留距离直到click，防止拖拽后再触发切档。
        }} onPointerCancel={() => { drag.current = null; panel.current?.style.removeProperty("--sheet-drag"); }}><span /></button>
        <div className="explore-sheet-title"><div><h2><CategoryIcon size={20} />附近{exploreCategories[category].label}笔记</h2></div>
          <div className="explore-sheet-tools"><IconButton label="重新整理附近笔记" onClick={refresh} disabled={busy || feed?.status === "loading" || !area}>{busy || feed?.status === "loading" ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />}</IconButton>
            <IconButton label={sheet === 2 ? "显示更多地图" : "显示更多笔记"} onClick={() => setSheet(sheet === 2 ? 0 : sheet + 1)}>{sheet === 2 ? <ChevronDown size={20} /> : <ChevronUp size={20} />}</IconButton></div></div>
        <div ref={list} className="explore-notes-scroll" onScroll={(event) => { saved.scroll = event.currentTarget.scrollTop; writeExploreState(storage, saved); }}
          onTouchStart={(event) => { touch.current = { y: event.touches[0].clientY, top: event.currentTarget.scrollTop }; }}
          onTouchEnd={(event) => {
            if (!touch.current) return;
            const delta = event.changedTouches[0].clientY - touch.current.y;
            if (delta < -60 && sheet < 2 || delta > 60 && touch.current.top <= 0) setSheet(snapExploreSheet(sheet, delta));
            touch.current = null;
          }}>
          {feed?.message && feed.status !== "error" && <p className="explore-feed-notice" role="status">{feed.message}</p>}
          {newNoteCount > 0 && <p className="explore-new-notes" role="status">附近新增 {newNoteCount} 篇笔记</p>}
          {busy && !places.length && <div className="explore-note-skeletons" aria-label="正在查找附近地点"><div /><div /></div>}
          <div className="explore-note-grid">
            {displayedNotes.map((note) => <ExploreNoteCard key={note.id} note={note} places={feed?.places || []}
              favorite={favoriteNoteIds.includes(note.id)} pending={pendingNoteIds.includes(note.id)}
              onOpen={() => onOpenNote(note.id)} onFavorite={() => onFavoriteNote(note)} />)}
          </div>
          {notePage.hasMore && <button className="explore-load-more" onClick={() => expand("notes")}>查看更多<ChevronDown size={17} /></button>}
          {!busy && !visibleNotes.length && !error && feed?.status !== "error" && !feed?.message && <p className="explore-feed-notice">{!search ? "正在确认探索区域…" : "暂未找到有可靠体验来源的推荐，可以移动地图或点击地点探索。"}</p>}
          {nearby.length > 0 && <section className="explore-nearby-list"><h3><MapPin size={16} />{category === "scenery" ? "值得去的景点" : `这一带的${exploreCategories[category].label}`}<span>距推荐中心 · 点击查看</span></h3>
            <div className="explore-place-grid">{displayedPlaces.map((place) => <PlaceLink key={place.id} place={place} caption={distanceText(place, search)} onOpen={onOpenPlace} onAdd={onAddPlace} />)}</div>
            {placePage.hasMore && <button className="explore-load-more" onClick={() => expand("places")}>查看更多<ChevronDown size={17} /></button>}</section>}
        </div>
      </section>
    </div>
    {noteId && <NoteDetail id={noteId} known={feed?.notes.find((note) => note.id === noteId)} knownPlaces={feed?.places || []}
      favorite={favoriteNoteIds.includes(noteId)} pending={pendingNoteIds.includes(noteId)} onFavorite={onFavoriteNote}
      onBack={onBackFromNote} onOpen={onOpenPlace} onAdd={onAddPlace} onPlaces={onPlaces} />}
  </>;
}

export function ExploreNoteCard({ note, places, favorite, pending, onOpen, onFavorite }: {
  note: ExploreNote; places: Place[]; favorite: boolean; pending: boolean; onOpen: () => void; onFavorite: () => void;
}) {
  const cover = places.find((place) => note.placeIds.includes(place.id) && place.photo) || places.find((place) => note.placeIds.includes(place.id));
  const Icon = icons[note.category];
  return <article className="explore-note-card">
    <button className="explore-note-main" onClick={onOpen} aria-label={`查看笔记：${note.title}`}>
      <div className="explore-note-cover">{cover ? <Photo place={cover} /> : <div className="explore-cover-placeholder"><Icon size={34} /></div>}</div>
      <div className="explore-note-caption"><h3>{note.title}</h3></div>
    </button>
    <NoteFavorite favorite={favorite} pending={pending} onClick={onFavorite} />
  </article>;
}

function NoteFavorite({ favorite, pending, onClick, className = "favorite-button" }: { favorite: boolean; pending: boolean; onClick: () => void; className?: string }) {
  return <IconButton label={favorite ? "取消笔记收藏" : "收藏笔记"} className={`${className} ${favorite ? "is-favorite" : ""}`} pressed={favorite} disabled={pending} onClick={onClick}>
    <Heart size={22} fill={favorite ? "currentColor" : "none"} />
  </IconButton>;
}

function PlaceLink({ place, caption, onOpen, onAdd }: { place: Place; caption?: string; onOpen: (place: Place) => void; onAdd: (place: Place) => void }) {
  return <article className="explore-place-link"><button className="explore-place-main" onClick={() => onOpen(place)} aria-label={`查看地点：${place.name}`}><Photo place={place} />
    <div className="glass-caption"><h3>{place.name}</h3><p><MapPin size={15} />{caption || `${place.category} · ${place.district || place.city}`}</p></div>
  </button><IconButton className="explore-place-add" label={`将${place.name}加入行程`} onClick={() => onAdd(place)}><Send size={23} strokeWidth={1.7} /></IconButton></article>;
}

function NoteDetail({ id, known, knownPlaces, favorite, pending, onFavorite, onBack, onOpen, onAdd, onPlaces }: {
  favorite: boolean; pending: boolean; onFavorite: (note: ExploreNote) => void;
  id: string; known?: ExploreNote; knownPlaces: Place[]; onBack: () => void; onOpen: (place: Place) => void; onAdd: (place: Place) => void; onPlaces: (places: Place[]) => void;
}) {
  const [result, setResult] = useState<{ note: ExploreNote; places: Place[] } | null>(known ? { note: known, places: knownPlaces } : null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setResult(known ? { note: known, places: knownPlaces } : null);
    api<{ note: ExploreNote; places: Place[] }>(`/explore/notes/${encodeURIComponent(id)}`, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) { setResult(value); onPlaces(value.places); }
    }).catch((e) => { if (!controller.signal.aborted) setError((e as Error).message); });
    return () => controller.abort();
  }, [id]);
  const note = result?.note;
  const cover = result?.places.find((place) => note?.placeIds.includes(place.id) && place.photo);
  const Icon = note ? icons[note.category] : BookOpen;
  return <article className="explore-note-detail">
    <div className="explore-note-detail-scroll">
      {!note && <Back onClick={onBack} title="探索笔记" />}
      {error && <p className="explore-feed-notice has-error" role="alert">{error}</p>}
      {!result && !error && <div className="full-loading"><LoaderCircle className="spin" /></div>}
      {note && <>
        <div className="detail-photo explore-detail-cover">{cover ? <Photo place={cover} /> : <div className="explore-cover-placeholder"><Icon size={48} /></div>}
          <div className="detail-top-actions"><IconButton label="返回笔记列表" className="detail-photo-button" onClick={onBack}><ArrowLeft size={22} /></IconButton>
            <NoteFavorite className="detail-photo-button" favorite={favorite} pending={pending} onClick={() => onFavorite(note)} /></div>
          <div className="glass-caption detail-caption explore-detail-caption"><div><h1>{note.title}</h1><p><MapPin size={18} />{note.placeIds.length} 个地点</p></div></div>
        </div>
        <div className="explore-article-body"><div className="explore-article-facts"><span><BookOpen size={19} />探索笔记</span><span><ExternalLink size={18} />{note.sources.length} 个来源</span></div>
          <p className="explore-article-intro">{note.summary}</p>
          {note.sections.map((section, index) => <section className="explore-article-section" key={index}><h2>{section.heading}</h2><p>{section.body}</p>
            <div className="explore-section-sources">{section.sourceUrls.map((url) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">来源 {note.sources.findIndex((source) => source.url === url) + 1}<ExternalLink size={10} /></a>)}</div>
            <div className="explore-place-grid">{section.placeIds.map((placeId) => { const place = result.places.find((p) => p.id === placeId); return place ? <PlaceLink key={placeId} place={place} onOpen={onOpen} onAdd={onAdd} /> : null; })}</div>
          </section>)}
          <section className="explore-original-sources"><h2>原文与来源</h2><p>以下内容整理自公开文章，营业和预约信息请查看地点详情。</p>{note.sources.map((source, index) => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer"><span>{index + 1}</span><div><strong>{source.title}</strong><small>{new URL(source.url).hostname}</small></div><ExternalLink size={18} /></a>)}</section>
          <p className="explore-article-meta">漫迹整理 · <time dateTime={note.updatedAt}>{shortDate(note.updatedAt)} 更新</time></p>
        </div>
      </>}
    </div>
  </article>;
}
