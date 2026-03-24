import { useState, useRef, useEffect } from 'react';

interface LazyImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  /** Optional low-res placeholder URL for blur-up effect */
  placeholderSrc?: string;
}

/**
 * K104: Lazy-loaded image with blur-up placeholder.
 * Uses native loading="lazy" + Intersection Observer for load trigger.
 */
export function LazyImage({
  src,
  alt = '',
  placeholderSrc,
  className = '',
  ...props
}: LazyImageProps) {
  const [loaded, setLoaded] = useState(false);
  const [inView, setInView] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <img
      ref={imgRef}
      src={inView ? src : (placeholderSrc || undefined)}
      alt={alt}
      loading="lazy"
      onLoad={() => setLoaded(true)}
      className={[
        className,
        !loaded && placeholderSrc ? 'img-blur-placeholder' : '',
        loaded ? 'img-blur-placeholder loaded' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  );
}
