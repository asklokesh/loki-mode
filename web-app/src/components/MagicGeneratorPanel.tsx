import { useCallback, useId, useRef, useState } from 'react';
import { Sparkles, Upload, X, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { MagicGenerateSpec, MagicTarget } from '../pages/MagicPage';

interface MagicGeneratorPanelProps {
  onGenerate: (spec: MagicGenerateSpec) => Promise<boolean>;
}

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

type GenerateStatus =
  | { state: 'idle' }
  | { state: 'submitting' }
  | { state: 'success'; message: string }
  | { state: 'error'; message: string };

export function MagicGeneratorPanel({ onGenerate }: MagicGeneratorPanelProps) {
  const nameId = useId();
  const descriptionId = useId();
  const tagsId = useId();
  const screenshotId = useId();
  const targetGroupId = useId();

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [name, setName] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [target, setTarget] = useState<MagicTarget>('both');
  const [tagsInput, setTagsInput] = useState<string>('');
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotName, setScreenshotName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<boolean>(false);

  const [nameError, setNameError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [status, setStatus] = useState<GenerateStatus>({ state: 'idle' });

  const readFileAsDataUrl = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => reject(reader.error ?? new Error('File read error'));
      reader.readAsDataURL(file);
    });
  }, []);

  const handleFile = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        setStatus({ state: 'error', message: 'Screenshot must be an image file.' });
        return;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        setScreenshot(dataUrl);
        setScreenshotName(file.name);
      } catch {
        setStatus({ state: 'error', message: 'Could not read the selected file.' });
      }
    },
    [readFileAsDataUrl],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      await handleFile(file);
    },
    [handleFile],
  );

  const clearScreenshot = useCallback(() => {
    setScreenshot(null);
    setScreenshotName(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const validate = useCallback((): boolean => {
    let ok = true;
    if (!name.trim()) {
      setNameError('Name is required.');
      ok = false;
    } else if (!NAME_PATTERN.test(name.trim())) {
      setNameError(
        'Name must start with a letter and contain only letters, numbers, hyphens, or underscores.',
      );
      ok = false;
    } else {
      setNameError(null);
    }

    if (!description.trim()) {
      setDescriptionError('Description is required.');
      ok = false;
    } else if (description.trim().length < 10) {
      setDescriptionError('Description should be at least 10 characters.');
      ok = false;
    } else {
      setDescriptionError(null);
    }

    return ok;
  }, [name, description]);

  const parseTags = useCallback((value: string): string[] => {
    return value
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (status.state === 'submitting') return;
      if (!validate()) return;

      setStatus({ state: 'submitting' });
      const spec: MagicGenerateSpec = {
        name: name.trim(),
        description: description.trim(),
        target,
        tags: parseTags(tagsInput),
        ...(screenshot ? { screenshot } : {}),
      };

      const ok = await onGenerate(spec);
      if (ok) {
        setStatus({
          state: 'success',
          message: `Component "${spec.name}" generated successfully.`,
        });
        setName('');
        setDescription('');
        setTagsInput('');
        setTarget('both');
        clearScreenshot();
      } else {
        setStatus({
          state: 'error',
          message: 'Generation failed. Please try again.',
        });
      }
    },
    [
      status.state,
      validate,
      name,
      description,
      target,
      tagsInput,
      screenshot,
      onGenerate,
      parseTags,
      clearScreenshot,
    ],
  );

  const submitting = status.state === 'submitting';

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="rounded-xl border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] shadow-sm"
    >
      <div className="px-6 py-5 border-b border-[#ECEAE3] dark:border-[#2A2A30]">
        <div className="flex items-center gap-2">
          <Sparkles className="text-[#553DE9]" size={18} aria-hidden="true" />
          <h3 className="text-base font-semibold text-[#36342E] dark:text-[#E8E6E3]">
            Generate a new component
          </h3>
        </div>
        <p className="mt-1 text-xs text-[#6B6960] dark:text-[#8A8880]">
          Provide a short spec. Loki will create the component, run a debate, and register it.
        </p>
      </div>

      <div className="px-6 py-5 space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Name */}
          <div>
            <label
              htmlFor={nameId}
              className="block text-xs font-medium text-[#36342E] dark:text-[#E8E6E3] mb-1.5"
            >
              Name
            </label>
            <input
              id={nameId}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. PricingCard"
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? `${nameId}-error` : undefined}
              className="w-full px-3 py-2 rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#121215] text-sm text-[#36342E] dark:text-[#E8E6E3] placeholder:text-[#939084] focus:outline-none focus:ring-2 focus:ring-[#553DE9]/40 focus:border-[#553DE9]"
            />
            {nameError ? (
              <p id={`${nameId}-error`} className="mt-1 text-xs text-[#C45B5B]">
                {nameError}
              </p>
            ) : (
              <p className="mt-1 text-xs text-[#939084]">
                Letters, numbers, hyphens, underscores. Must start with a letter.
              </p>
            )}
          </div>

          {/* Tags */}
          <div>
            <label
              htmlFor={tagsId}
              className="block text-xs font-medium text-[#36342E] dark:text-[#E8E6E3] mb-1.5"
            >
              Tags
            </label>
            <input
              id={tagsId}
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="marketing, pricing, card"
              className="w-full px-3 py-2 rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#121215] text-sm text-[#36342E] dark:text-[#E8E6E3] placeholder:text-[#939084] focus:outline-none focus:ring-2 focus:ring-[#553DE9]/40 focus:border-[#553DE9]"
            />
            <p className="mt-1 text-xs text-[#939084]">
              Comma-separated list used for search and grouping.
            </p>
          </div>
        </div>

        {/* Description */}
        <div>
          <label
            htmlFor={descriptionId}
            className="block text-xs font-medium text-[#36342E] dark:text-[#E8E6E3] mb-1.5"
          >
            Description
          </label>
          <textarea
            id={descriptionId}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder="Describe what this component should look like and how it behaves."
            aria-invalid={descriptionError ? true : undefined}
            aria-describedby={descriptionError ? `${descriptionId}-error` : undefined}
            className="w-full px-3 py-2 rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#121215] text-sm text-[#36342E] dark:text-[#E8E6E3] placeholder:text-[#939084] focus:outline-none focus:ring-2 focus:ring-[#553DE9]/40 focus:border-[#553DE9] resize-y"
          />
          {descriptionError ? (
            <p id={`${descriptionId}-error`} className="mt-1 text-xs text-[#C45B5B]">
              {descriptionError}
            </p>
          ) : null}
        </div>

        {/* Target */}
        <fieldset>
          <legend
            id={targetGroupId}
            className="block text-xs font-medium text-[#36342E] dark:text-[#E8E6E3] mb-1.5"
          >
            Target
          </legend>
          <div
            role="radiogroup"
            aria-labelledby={targetGroupId}
            className="flex flex-wrap gap-2"
          >
            {(
              [
                { value: 'react', label: 'React' },
                { value: 'webcomponent', label: 'Web Component' },
                { value: 'both', label: 'Both' },
              ] as { value: MagicTarget; label: string }[]
            ).map((opt) => {
              const selected = target === opt.value;
              return (
                <label
                  key={opt.value}
                  className={[
                    'inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer transition-colors',
                    selected
                      ? 'border-[#553DE9] bg-[#553DE9]/10 text-[#553DE9]'
                      : 'border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#121215] text-[#36342E] dark:text-[#E8E6E3] hover:border-[#553DE9]/50',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    name="magic-target"
                    value={opt.value}
                    checked={selected}
                    onChange={() => setTarget(opt.value)}
                    className="sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className={[
                      'inline-block h-3 w-3 rounded-full border',
                      selected
                        ? 'border-[#553DE9] bg-[#553DE9]'
                        : 'border-[#939084] bg-transparent',
                    ].join(' ')}
                  />
                  {opt.label}
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* Screenshot upload */}
        <div>
          <label
            htmlFor={screenshotId}
            className="block text-xs font-medium text-[#36342E] dark:text-[#E8E6E3] mb-1.5"
          >
            Screenshot <span className="text-[#939084] font-normal">(optional)</span>
          </label>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={[
              'flex items-center gap-3 rounded-lg border-2 border-dashed px-4 py-4 transition-colors',
              dragOver
                ? 'border-[#553DE9] bg-[#553DE9]/5'
                : 'border-[#ECEAE3] dark:border-[#2A2A30] bg-[#FAF9F6] dark:bg-[#121215]',
            ].join(' ')}
          >
            {screenshot ? (
              <>
                <img
                  src={screenshot}
                  alt={screenshotName ? `Uploaded ${screenshotName}` : 'Uploaded screenshot preview'}
                  className="h-16 w-16 object-cover rounded-md border border-[#ECEAE3] dark:border-[#2A2A30]"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[#36342E] dark:text-[#E8E6E3] truncate">
                    {screenshotName ?? 'screenshot'}
                  </p>
                  <p className="text-xs text-[#939084]">Drop a new image to replace.</p>
                </div>
                <button
                  type="button"
                  onClick={clearScreenshot}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-[#6B6960] dark:text-[#8A8880] hover:text-[#C45B5B] focus:outline-none focus:ring-2 focus:ring-[#553DE9]/40"
                  aria-label="Remove screenshot"
                >
                  <X size={14} aria-hidden="true" />
                  Remove
                </button>
              </>
            ) : (
              <>
                <Upload className="text-[#553DE9]" size={20} aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[#36342E] dark:text-[#E8E6E3]">
                    Drag and drop an image, or
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="ml-1 underline text-[#553DE9] hover:text-[#3F2BB8] focus:outline-none focus:ring-2 focus:ring-[#553DE9]/40 rounded"
                    >
                      browse
                    </button>
                  </p>
                  <p className="text-xs text-[#939084]">PNG or JPG up to 5 MB.</p>
                </div>
              </>
            )}
            <input
              ref={fileInputRef}
              id={screenshotId}
              type="file"
              accept="image/*"
              onChange={(e) => void handleFile(e.target.files?.[0])}
              className="sr-only"
            />
          </div>
        </div>

        {/* Status messages */}
        {status.state === 'error' ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[#C45B5B]/30 bg-[#C45B5B]/10 px-3 py-2 text-xs text-[#C45B5B]"
          >
            <AlertCircle size={14} aria-hidden="true" className="mt-0.5" />
            <span>{status.message}</span>
          </div>
        ) : status.state === 'success' ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-[#1FC5A8]/30 bg-[#1FC5A8]/10 px-3 py-2 text-xs text-[#1FC5A8]"
          >
            <CheckCircle2 size={14} aria-hidden="true" className="mt-0.5" />
            <span>{status.message}</span>
          </div>
        ) : null}
      </div>

      <div className="px-6 py-4 border-t border-[#ECEAE3] dark:border-[#2A2A30] flex items-center justify-end gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#553DE9] text-white text-sm font-medium shadow-sm hover:bg-[#3F2BB8] focus:outline-none focus:ring-2 focus:ring-[#553DE9]/40 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-[#1A1A1E] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting ? (
            <>
              <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Generating...
            </>
          ) : (
            <>
              <Sparkles size={16} aria-hidden="true" />
              Generate
            </>
          )}
        </button>
      </div>
    </form>
  );
}
