import React, { useState, useRef, useEffect } from 'react';
import {
  UploadCloud,
  FileText,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Plus,
  Trash2,
  X,
  RotateCcw,
  Briefcase,
  GraduationCap,
  Code2,
  ArrowRight,
  FileCheck,
  Edit3
} from 'lucide-react';
import { UserProfile, Experience, Education, ContractType } from '../types';
import { apiFetch } from '../utils/api';
import { buildImportedProfile, importWarnings, type ImportMode, type ImportWarning } from '../utils/cvImport';
import { Button, Modal, cx } from './ui';

/** Type MIME d'un document Word (.docx) : le serveur en extrait le texte. */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_FILE_SIZE = 8 * 1024 * 1024;

interface CvUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentProfile: UserProfile;
  onSaveProfile: (profile: UserProfile) => Promise<void>;
  isMandatoryOnboarding?: boolean;
}

export const CvUploadModal: React.FC<CvUploadModalProps> = ({
  isOpen,
  onClose,
  currentProfile,
  onSaveProfile,
  isMandatoryOnboarding = false
}) => {
  const [step, setStep] = useState<'upload' | 'confirm' | 'success'>('upload');
  const [inputMode, setInputMode] = useState<'file' | 'text'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [cvText, setCvText] = useState<string>('');
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [extractedProfile, setExtractedProfile] = useState<UserProfile>(currentProfile);
  const [newSkill, setNewSkill] = useState<string>('');
  const [newLanguage, setNewLanguage] = useState<string>('');
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [parsedCv, setParsedCv] = useState<any>(null);
  const [importMode, setImportMode] = useState<ImportMode>('replace');
  const [warnings, setWarnings] = useState<ImportWarning[]>([]);
  const [kept, setKept] = useState<string[]>([]);
  const [hasPreviousProfile, setHasPreviousProfile] = useState(false);

  const switchMode = (mode: ImportMode) => {
    if (!parsedCv || mode === importMode) return;
    const r = buildImportedProfile(currentProfile, parsedCv, mode);
    setImportMode(mode);
    setExtractedProfile(r.profile);
    setKept(r.keptFromPrevious);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const uid = React.useId();
  const fid = (name: string) => `${uid}-${name}`;
  const errorId = fid('error');

  // Réinitialise la fenêtre à chaque ouverture (avant, elle restait sur l'écran « succès »)
  useEffect(() => {
    if (isOpen) {
      setStep('upload');
      setFile(null);
      setAnalysisError(null);
      setExtractedProfile(currentProfile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setAnalysisError(null);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setFile(e.dataTransfer.files[0]);
      setAnalysisError(null);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const readFileAsBase64 = (f: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = (error) => reject(error);
      reader.readAsDataURL(f);
    });
  };

  const readFileAsText = (f: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = (error) => reject(error);
      reader.readAsText(f);
    });
  };

  const handleStartAnalysis = async () => {
    setAnalysisError(null);

    if (inputMode === 'file' && !file) {
      setAnalysisError('Sélectionnez ou déposez votre CV (PDF, Word .docx, image ou texte).');
      return;
    }

    if (inputMode === 'text' && !cvText.trim()) {
      setAnalysisError('Collez le texte de votre CV dans le champ prévu.');
      return;
    }

    setIsAnalyzing(true);

    try {
      let payload: { fileBase64?: string; mimeType?: string; cvText?: string } = {};

      if (inputMode === 'file' && file) {
        const lowerName = file.name.toLowerCase();
        const isPdf = file.type === 'application/pdf' || lowerName.endsWith('.pdf');
        const isText = file.type.startsWith('text/') || lowerName.endsWith('.txt') || lowerName.endsWith('.md');
        const isDocx = file.type === DOCX_MIME || lowerName.endsWith('.docx');
        const isImage = /^image\/(png|jpeg|webp)$/.test(file.type);

        if (!isPdf && !isDocx && !isText && !isImage) {
          throw new Error('Format non pris en charge. Utilisez un PDF, un fichier Word (.docx), une image PNG/JPEG, ou collez le texte.');
        }
        if (file.size > MAX_FILE_SIZE) {
          throw new Error('Fichier trop volumineux (8 Mo maximum).');
        }

        if (isText) {
          const textContent = await readFileAsText(file);
          payload = { cvText: textContent };
        } else {
          // Read base64 (works natively for PDF & documents)
          const base64Content = await readFileAsBase64(file);
          payload = {
            fileBase64: base64Content,
            mimeType: isPdf ? 'application/pdf' : isDocx ? (file.type || DOCX_MIME) : file.type
          };
        }
      } else {
        payload = { cvText: cvText.trim() };
      }

      const res = await apiFetch('/api/cv/analyze', payload);

      let data: any = null;
      try {
        const rawText = await res.text();
        data = JSON.parse(rawText);
      } catch {
        if (!res.ok) {
          throw new Error(`Le service d'analyse a rencontré une erreur temporaire (${res.status}). Veuillez réessayer.`);
        }
        throw new Error("Réponse inattendue reçue du serveur d'analyse.");
      }

      if (!res.ok || !data?.success || !data?.profile) {
        throw new Error(data?.error || `Impossible d'extraire les données du CV (${res.status}).`);
      }

      const p = data.profile;
      // Profil existant : remplacé par défaut (aucun mélange silencieux) ; « compléter » reste possible
      const hadProfile = (currentProfile.experiences?.length || 0) > 0 || (currentProfile.skills?.length || 0) > 0;
      const mode: ImportMode = 'replace';
      setParsedCv(p);
      setImportMode(mode);
      setWarnings(importWarnings(p, currentProfile));
      setHasPreviousProfile(hadProfile);
      const { profile: preparedProfile, keptFromPrevious } = buildImportedProfile(currentProfile, p, mode);
      setKept(keptFromPrevious);
      setExtractedProfile(preparedProfile);
      setStep('confirm');

    } catch (err: any) {
      console.error("Analysis failure:", err);
      setAnalysisError(err?.message || "Une erreur est survenue lors de l'analyse du CV.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleConfirmAndSave = async () => {
    setIsSaving(true);
    try {
      await onSaveProfile(extractedProfile);
      setStep('success');
    } catch (err) {
      console.error("Save error:", err);
      setAnalysisError("Impossible d'enregistrer le profil en ligne. Vérifiez votre connexion et réessayez.");
    } finally {
      setIsSaving(false);
    }
  };

  // Skill Management Helpers
  const handleAddSkill = (e?: React.SyntheticEvent) => {
    if (e) e.preventDefault();
    if (!newSkill.trim()) return;
    if (!extractedProfile.skills.includes(newSkill.trim())) {
      setExtractedProfile(prev => ({
        ...prev,
        skills: [...prev.skills, newSkill.trim()]
      }));
    }
    setNewSkill('');
  };

  const handleRemoveSkill = (skillToRemove: string) => {
    setExtractedProfile(prev => ({
      ...prev,
      skills: prev.skills.filter(s => s !== skillToRemove)
    }));
  };

  // Language helpers
  const handleAddLanguage = (e?: React.SyntheticEvent) => {
    if (e) e.preventDefault();
    if (!newLanguage.trim()) return;
    if (!extractedProfile.languages.includes(newLanguage.trim())) {
      setExtractedProfile(prev => ({
        ...prev,
        languages: [...prev.languages, newLanguage.trim()]
      }));
    }
    setNewLanguage('');
  };

  const handleRemoveLanguage = (langToRemove: string) => {
    setExtractedProfile(prev => ({
      ...prev,
      languages: prev.languages.filter(l => l !== langToRemove)
    }));
  };

  // Experiences helpers
  const handleUpdateExperience = (index: number, field: keyof Experience, value: any) => {
    setExtractedProfile(prev => {
      const copy = [...prev.experiences];
      copy[index] = { ...copy[index], [field]: value };
      return { ...prev, experiences: copy };
    });
  };

  const handleRemoveExperience = (index: number) => {
    setExtractedProfile(prev => ({
      ...prev,
      experiences: prev.experiences.filter((_, i) => i !== index)
    }));
  };

  const handleAddExperience = () => {
    const newExp: Experience = {
      id: `exp-${Date.now()}`,
      // Champs vides : rien de fictif ne doit se retrouver dans un CV si l'utilisateur oublie de les remplir
      title: '',
      company: '',
      location: '',
      startDate: '',
      endDate: '',
      current: false,
      technologies: [],
      bullets: []
    };
    setExtractedProfile(prev => ({
      ...prev,
      experiences: [newExp, ...prev.experiences]
    }));
  };

  // Education helpers
  const handleRemoveEducation = (index: number) => {
    setExtractedProfile(prev => ({
      ...prev,
      education: prev.education.filter((_, i) => i !== index)
    }));
  };

  const handleAddEducation = () => {
    const newEdu: Education = {
      id: `edu-${Date.now()}`,
      degree: '',
      institution: '',
      year: '',
      details: ''
    };
    setExtractedProfile(prev => ({
      ...prev,
      education: [...prev.education, newEdu]
    }));
  };

  const handleToggleContract = (contract: ContractType) => {
    const current = extractedProfile.preferredContracts || [];
    const next = current.includes(contract)
      ? current.filter(c => c !== contract)
      : [...current, contract];
    setExtractedProfile(prev => ({ ...prev, preferredContracts: next }));
  };

  // Styles partagés
  const inputClass =
    'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30';
  const labelClass = 'mb-1.5 block text-sm font-medium text-slate-700';
  const sectionClass = 'space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5';
  const sectionTitleClass = 'flex items-center gap-2 text-sm font-semibold text-slate-900';

  const title =
    step === 'upload' ? 'Importer votre CV' : step === 'confirm' ? 'Vérifiez les informations extraites' : 'Profil enregistré';
  const subtitle =
    step === 'upload'
      ? 'Seules vos vraies données sont utilisées : rien de générique ni de fictif.'
      : step === 'confirm'
        ? 'Relisez et corrigez les données extraites avant de les enregistrer.'
        : 'Votre profil candidat est à jour.';

  const canAnalyze = !isAnalyzing && !((inputMode === 'file' && !file) || (inputMode === 'text' && !cvText.trim()));

  const identityFields: { key: keyof UserProfile; label: string; type?: string; placeholder: string; autoComplete?: string }[] = [
    { key: 'fullName', label: 'Nom complet', placeholder: 'ex. Ayman Hakim', autoComplete: 'name' },
    { key: 'title', label: 'Titre professionnel', placeholder: 'ex. Chargé(e) RH, Comptable, Développeur…', autoComplete: 'organization-title' },
    { key: 'email', label: 'E-mail', type: 'email', placeholder: 'prenom.nom@exemple.com', autoComplete: 'email' },
    { key: 'phone', label: 'Téléphone', type: 'tel', placeholder: '+33 6 …', autoComplete: 'tel' },
    { key: 'location', label: 'Ville et mobilité', placeholder: 'Paris, France (télétravail)' },
    { key: 'linkedinUrl', label: 'Profil LinkedIn', placeholder: 'linkedin.com/in/…' },
    { key: 'githubUrl', label: 'Profil GitHub', placeholder: 'github.com/…' },
    { key: 'portfolioUrl', label: 'Site web / portfolio', placeholder: 'mon-site.fr' }
  ];

  const footer =
    step === 'upload' ? (
      <>
        {!isMandatoryOnboarding && (
          <Button type="button" variant="secondary" onClick={onClose} className="w-full sm:w-auto">
            Annuler
          </Button>
        )}
        <Button type="button" variant="primary" onClick={handleStartAnalysis} disabled={!canAnalyze} className="w-full sm:w-auto">
          {isAnalyzing ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
              Analyse en cours…
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Analyser mon CV
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </>
          )}
        </Button>
      </>
    ) : step === 'confirm' ? (
      <>
        <Button type="button" variant="secondary" onClick={() => setStep('upload')} className="w-full sm:mr-auto sm:w-auto">
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          Importer un autre document
        </Button>
        {!isMandatoryOnboarding && (
          <Button type="button" variant="ghost" onClick={onClose} className="w-full sm:w-auto">
            Annuler (rien n’est enregistré)
          </Button>
        )}
        <Button type="button" variant="primary" onClick={handleConfirmAndSave} disabled={isSaving} className="w-full sm:w-auto">
          {isSaving ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
              Enregistrement…
            </>
          ) : (
            <>
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              Confirmer et enregistrer
            </>
          )}
        </Button>
      </>
    ) : (
      <Button type="button" variant="primary" onClick={onClose} className="w-full sm:w-auto">
        Voir les offres
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Button>
    );

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      size={step === 'confirm' ? 'xl' : 'lg'}
      dismissible={!isMandatoryOnboarding}
      footer={footer}
    >
      <div className="space-y-5 px-5 py-5 sm:px-6">
        {/* ÉTAPE 1 : IMPORT */}
        {step === 'upload' && (
          <>
            <div className="flex items-start gap-3 rounded-2xl border border-brand-200 bg-brand-50 p-4">
              <FileCheck className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" aria-hidden="true" />
              <div className="space-y-1 text-sm">
                <p className="font-semibold text-slate-900">Extraction fidèle de votre parcours</p>
                <p className="leading-relaxed text-slate-700">
                  Importez votre CV ou collez son texte : l'IA en extrait vos coordonnées, expériences, formations et compétences. Vous pourrez tout vérifier avant l'enregistrement.
                </p>
              </div>
            </div>

            {/* Choix du mode d'import */}
            <div role="group" aria-label="Mode d'import" className="grid grid-cols-1 gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1 sm:grid-cols-2">
              {([
                { id: 'file', label: 'Importer un fichier', icon: UploadCloud },
                { id: 'text', label: 'Coller le texte', icon: FileText }
              ] as const).map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => { setInputMode(id); setAnalysisError(null); }}
                  aria-pressed={inputMode === id}
                  className={cx(
                    'flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors',
                    inputMode === id ? 'border border-slate-200 bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                  )}
                >
                  <Icon className={cx('h-4 w-4', inputMode === id ? 'text-brand-600' : 'text-slate-400')} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>

            {/* Mode fichier : zone de dépôt */}
            {inputMode === 'file' && (
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); }
                }}
                role="button"
                tabIndex={0}
                aria-label={file ? `Fichier sélectionné : ${file.name}. Choisir un autre fichier` : 'Choisir un fichier de CV'}
                aria-describedby={fid('formats')}
                className={cx(
                  'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-6 text-center transition-colors sm:p-8',
                  file ? 'border-brand-400 bg-brand-50' : 'border-slate-300 bg-slate-50 hover:border-brand-400 hover:bg-brand-50'
                )}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={`.pdf,application/pdf,.docx,${DOCX_MIME},.txt,.md,image/png,image/jpeg,image/webp`}
                  onChange={handleFileChange}
                  className="hidden"
                  tabIndex={-1}
                  aria-hidden="true"
                />

                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-100 text-brand-600">
                  {file ? <FileCheck className="h-6 w-6" aria-hidden="true" /> : <UploadCloud className="h-6 w-6" aria-hidden="true" />}
                </div>

                {file ? (
                  <div className="min-w-0 max-w-full">
                    <p className="break-all text-sm font-semibold text-slate-900">{file.name}</p>
                    <p className="mt-0.5 text-xs font-medium text-brand-700">{(file.size / 1024).toFixed(1)} Ko · prêt pour l'analyse</p>
                    <p className="mt-1 text-xs text-slate-500">Cliquez pour choisir un autre fichier</p>
                  </div>
                ) : (
                  <p className="text-sm font-semibold text-slate-900">
                    Glissez-déposez votre CV ici, ou <span className="text-brand-700 underline">parcourez vos fichiers</span>
                  </p>
                )}
                <p id={fid('formats')} className="text-xs text-slate-500">
                  PDF, Word (.docx), image (PNG/JPEG) ou texte collé · 8 Mo maximum
                </p>
              </div>
            )}

            {/* Mode texte */}
            {inputMode === 'text' && (
              <div>
                <label htmlFor={fid('cvtext')} className={labelClass}>Texte complet de votre CV</label>
                <textarea
                  id={fid('cvtext')}
                  value={cvText}
                  onChange={(e) => setCvText(e.target.value)}
                  rows={9}
                  placeholder="Nom, coordonnées, expériences, diplômes, compétences…"
                  aria-describedby={cx(fid('cvtext-help'), analysisError && errorId) || undefined}
                  className="w-full rounded-xl border border-slate-300 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800 placeholder:text-slate-400 focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/30"
                />
                <p id={fid('cvtext-help')} className="mt-1.5 text-xs text-slate-500">
                  Formats acceptés : PDF, Word (.docx), image (PNG/JPEG) ou texte collé ; 8 Mo maximum. Astuce : ouvrez votre CV, sélectionnez tout (Ctrl+A), copiez puis collez ici.
                </p>
              </div>
            )}

            {analysisError && (
              <div id={errorId} role="alert" className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
                <span>{analysisError}</span>
              </div>
            )}
          </>
        )}

        {/* ÉTAPE 2 : VÉRIFICATION */}
        {step === 'confirm' && (
          <>
            {hasPreviousProfile && (
              <fieldset className="space-y-2 rounded-2xl border border-brand-200 bg-brand-50 p-4">
                <legend className="px-1 text-sm font-semibold text-slate-900">Votre profil contient déjà des informations</legend>
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input type="radio" name="import-mode" className="mt-1" checked={importMode === 'replace'} onChange={() => switchMode('replace')} />
                  <span><strong>Remplacer mon profil par ce CV</strong> (recommandé) : seules les informations de ce CV sont gardées ; vos réglages de recherche restent.</span>
                </label>
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input type="radio" name="import-mode" className="mt-1" checked={importMode === 'complete'} onChange={() => switchMode('complete')} />
                  <span><strong>Compléter mon profil actuel</strong> : ce que le CV ne contient pas est repris de votre profil.</span>
                </label>
                {importMode === 'complete' && kept.length > 0 && (
                  <p className="text-xs text-slate-600">Repris de votre profil actuel : {kept.join(', ')}.</p>
                )}
              </fieldset>
            )}
            {warnings.length > 0 && (
              <div role="alert" className="space-y-1 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <p className="font-semibold">À vérifier avant d’enregistrer</p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {warnings.map((w, i) => <li key={i} className={w.level === 'important' ? 'font-medium' : ''}>{w.message}</li>)}
                </ul>
              </div>
            )}
            {analysisError && (
              <div id={errorId} role="alert" className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" aria-hidden="true" />
                <span>{analysisError}</span>
              </div>
            )}

            <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
              <div className="space-y-1 text-sm">
                <p className="font-semibold text-amber-900">Validation requise</p>
                <p className="leading-relaxed text-amber-800">
                  Ces informations ont été extraites de votre CV. Vérifiez-les et corrigez-les si besoin avant d'enregistrer votre profil.
                </p>
              </div>
            </div>

            {/* 1. Identité */}
            <section className={sectionClass} aria-labelledby={fid('s-identity')}>
              <h3 id={fid('s-identity')} className={sectionTitleClass}>
                <Edit3 className="h-4 w-4 text-brand-600" aria-hidden="true" />
                Identité et coordonnées
              </h3>
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
                {identityFields.map((f) => (
                  <div key={f.key} className="min-w-0">
                    <label htmlFor={fid(`id-${f.key}`)} className={labelClass}>{f.label}</label>
                    <input
                      id={fid(`id-${f.key}`)}
                      type={f.type || 'text'}
                      autoComplete={f.autoComplete}
                      value={(extractedProfile[f.key] as string) || ''}
                      onChange={(e) => setExtractedProfile({ ...extractedProfile, [f.key]: e.target.value })}
                      placeholder={f.placeholder}
                      className={inputClass}
                    />
                  </div>
                ))}
              </div>
            </section>

            {/* 2. Résumé */}
            <section className={sectionClass}>
              <label htmlFor={fid('summary')} className={sectionTitleClass}>
                <FileText className="h-4 w-4 text-brand-600" aria-hidden="true" />
                Résumé professionnel
              </label>
              <textarea
                id={fid('summary')}
                value={extractedProfile.summary}
                onChange={(e) => setExtractedProfile({ ...extractedProfile, summary: e.target.value })}
                rows={3}
                className={cx(inputClass, 'resize-y leading-relaxed')}
                placeholder="Brève présentation extraite du CV…"
              />
            </section>

            {/* 3. Compétences */}
            <section className={sectionClass} aria-labelledby={fid('s-skills')}>
              <h3 id={fid('s-skills')} className={sectionTitleClass}>
                <Code2 className="h-4 w-4 text-brand-600" aria-hidden="true" />
                Compétences ({extractedProfile.skills.length})
              </h3>

              <div className="flex flex-col gap-2 sm:flex-row">
                <label htmlFor={fid('new-skill')} className="sr-only">Nouvelle compétence</label>
                <input
                  id={fid('new-skill')}
                  type="text"
                  value={newSkill}
                  onChange={(e) => setNewSkill(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddSkill(); } }}
                  placeholder="Ajouter une compétence (ex. Excel, Recrutement, Python…)"
                  className={cx(inputClass, 'min-w-0 flex-1')}
                />
                <Button type="button" variant="primary" onClick={handleAddSkill}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Ajouter
                </Button>
              </div>

              <ul className="thin-scroll flex max-h-48 flex-wrap gap-1.5 overflow-y-auto" aria-label="Compétences">
                {extractedProfile.skills.map((skill) => (
                  <li key={skill} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-brand-200 bg-brand-50 py-1 pl-2.5 pr-1 text-sm font-medium text-brand-700">
                    <span className="truncate">{skill}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveSkill(skill)}
                      aria-label={`Retirer la compétence ${skill}`}
                      className="rounded p-0.5 text-brand-400 hover:bg-white hover:text-rose-600"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
              {extractedProfile.skills.length === 0 && (
                <p className="text-sm text-slate-500">Aucune compétence. Ajoutez-en avec le champ ci-dessus.</p>
              )}
            </section>

            {/* 4. Expériences */}
            <section className={sectionClass} aria-labelledby={fid('s-exp')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={fid('s-exp')} className={sectionTitleClass}>
                  <Briefcase className="h-4 w-4 text-brand-600" aria-hidden="true" />
                  Expériences ({extractedProfile.experiences.length})
                </h3>
                <Button type="button" variant="secondary" size="sm" onClick={handleAddExperience}>
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  Ajouter une expérience
                </Button>
              </div>

              <div className="space-y-3">
                {extractedProfile.experiences.map((exp, idx) => {
                  const k = `exp-${idx}`;
                  return (
                    <div key={exp.id || idx} className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3.5 sm:p-4">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-800">Expérience {idx + 1}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveExperience(idx)}
                          aria-label={`Supprimer l'expérience ${idx + 1}`}
                          title="Supprimer cette expérience"
                          className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="min-w-0">
                          <label htmlFor={fid(`${k}-title`)} className={labelClass}>Poste</label>
                          <input id={fid(`${k}-title`)} type="text" value={exp.title}
                            onChange={(e) => handleUpdateExperience(idx, 'title', e.target.value)} className={inputClass} />
                        </div>
                        <div className="min-w-0">
                          <label htmlFor={fid(`${k}-company`)} className={labelClass}>Entreprise</label>
                          <input id={fid(`${k}-company`)} type="text" value={exp.company}
                            onChange={(e) => handleUpdateExperience(idx, 'company', e.target.value)} className={inputClass} />
                        </div>
                        <div className="min-w-0">
                          <label htmlFor={fid(`${k}-dates`)} className={labelClass}>Dates</label>
                          <input
                            id={fid(`${k}-dates`)}
                            type="text"
                            value={`${exp.startDate} - ${exp.endDate}`}
                            onChange={(e) => {
                              const parts = e.target.value.split('-');
                              handleUpdateExperience(idx, 'startDate', parts[0]?.trim() || '');
                              handleUpdateExperience(idx, 'endDate', parts[1]?.trim() || '');
                            }}
                            placeholder="2022 - 2024"
                            className={inputClass}
                          />
                        </div>
                        <div className="min-w-0">
                          <label htmlFor={fid(`${k}-tech`)} className={labelClass}>Outils et technologies</label>
                          <input
                            id={fid(`${k}-tech`)}
                            type="text"
                            value={exp.technologies.join(', ')}
                            onChange={(e) => handleUpdateExperience(idx, 'technologies', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
                            placeholder="Excel, Salesforce, React…"
                            className={inputClass}
                          />
                        </div>
                      </div>

                      <div>
                        <label htmlFor={fid(`${k}-bullets`)} className={labelClass}>Réalisations (une par ligne)</label>
                        <textarea
                          id={fid(`${k}-bullets`)}
                          value={exp.bullets.join('\n')}
                          onChange={(e) => handleUpdateExperience(idx, 'bullets', e.target.value.split('\n').filter(Boolean))}
                          rows={3}
                          className={cx(inputClass, 'resize-y')}
                          placeholder="Une réalisation par ligne…"
                        />
                      </div>
                    </div>
                  );
                })}
                {extractedProfile.experiences.length === 0 && (
                  <p className="text-sm text-slate-500">Aucune expérience renseignée.</p>
                )}
              </div>
            </section>

            {/* 5. Formations */}
            <section className={sectionClass} aria-labelledby={fid('s-edu')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={fid('s-edu')} className={sectionTitleClass}>
                  <GraduationCap className="h-4 w-4 text-brand-600" aria-hidden="true" />
                  Formations ({extractedProfile.education.length})
                </h3>
                <Button type="button" variant="secondary" size="sm" onClick={handleAddEducation}>
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  Ajouter une formation
                </Button>
              </div>

              <div className="space-y-2.5">
                {extractedProfile.education.map((edu, idx) => {
                  const update = (field: 'degree' | 'institution' | 'year', value: string) => {
                    const copy = [...extractedProfile.education];
                    copy[idx] = { ...copy[idx], [field]: value };
                    setExtractedProfile({ ...extractedProfile, education: copy });
                  };
                  return (
                    <div key={edu.id || idx} className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
                        <input type="text" value={edu.degree} onChange={(e) => update('degree', e.target.value)}
                          placeholder="Diplôme" aria-label={`Diplôme (formation ${idx + 1})`} className={inputClass} />
                        <input type="text" value={edu.institution} onChange={(e) => update('institution', e.target.value)}
                          placeholder="Établissement" aria-label={`Établissement (formation ${idx + 1})`} className={inputClass} />
                        <input type="text" value={edu.year} onChange={(e) => update('year', e.target.value)}
                          placeholder="Année" aria-label={`Année (formation ${idx + 1})`} className={inputClass} />
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveEducation(idx)}
                        aria-label={`Supprimer la formation ${idx + 1}`}
                        className="mt-1 rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
                {extractedProfile.education.length === 0 && (
                  <p className="text-sm text-slate-500">Aucune formation renseignée.</p>
                )}
              </div>
            </section>

            {/* 6. Contrats */}
            <section className={sectionClass} aria-labelledby={fid('s-contracts')}>
              <h3 id={fid('s-contracts')} className={sectionTitleClass}>Types de contrat recherchés</h3>
              <div className="flex flex-wrap gap-2">
                {(['stage', 'alternance', 'cdi', 'cdd', 'freelance'] as ContractType[]).map((c) => {
                  const active = !!extractedProfile.preferredContracts?.includes(c);
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => handleToggleContract(c)}
                      aria-pressed={active}
                      className={cx(
                        'rounded-xl border px-3.5 py-1.5 text-sm font-semibold transition-colors',
                        c === 'cdi' || c === 'cdd' ? 'uppercase' : 'capitalize',
                        active ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400'
                      )}
                    >
                      {c}
                    </button>
                  );
                })}
              </div>
            </section>
          </>
        )}

        {/* ÉTAPE 3 : SUCCÈS */}
        {step === 'success' && (
          <div className="space-y-4 px-2 py-6 text-center" role="status">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
              <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
            </div>
            <div className="space-y-1.5">
              <h3 className="text-lg font-semibold text-slate-900">Profil enregistré</h3>
              <p className="mx-auto max-w-md text-sm leading-relaxed text-slate-600">
                Vos compétences et votre parcours réels servent désormais à évaluer votre adéquation avec les offres et à la génération de vos CV.
              </p>
            </div>
            {(extractedProfile.fullName || extractedProfile.title) && (
              <div className="inline-flex max-w-full flex-wrap items-center justify-center gap-x-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-700">
                <span className="font-semibold text-slate-900">{extractedProfile.fullName}</span>
                {extractedProfile.title && <span aria-hidden="true">·</span>}
                <span>{extractedProfile.title}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};
