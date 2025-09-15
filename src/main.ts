#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as yauzl from 'yauzl';
import { promisify } from 'util';
import * as xml2js from 'xml2js';

const program = new Command();

// Define the CLI interface
program
    .name('obsidiant')
    .description('CLI tool for processing EPUB files')
    .version('0.0.1');

// Add the main command with --mode epub option
program
    .argument('<input>', 'Input EPUB file path')
    .option('-m, --mode <mode>', 'Processing mode', 'epub')
    .option('-o, --output <path>', 'Output directory path', './Books')
    .action(async (input: string, options: { mode: string; output: string; }) => {
        await processEpubFile(input, options.mode, options.output);
    });

/**
 * Process an EPUB file based on the specified mode
 */
async function processEpubFile(inputPath: string, mode: string, outputPath: string): Promise<void> {
    console.log(`Processing file: ${inputPath}`);
    console.log(`Mode: ${mode}`);
    console.log(`Output directory: ${outputPath}`);

    // Validate input file exists
    if (!fs.existsSync(inputPath)) {
        console.error(`Error: File '${inputPath}' does not exist.`);
        process.exit(1);
    }

    // Validate file extension
    const fileExtension = path.extname(inputPath).toLowerCase();
    if (fileExtension !== '.epub') {
        console.error(`Error: Expected .epub file, but got '${fileExtension}' file.`);
        process.exit(1);
    }

    // Validate mode
    if (mode !== 'epub') {
        console.error(`Error: Unsupported mode '${mode}'. Currently only 'epub' mode is supported.`);
        process.exit(1);
    }

    try {
        console.log('🔄 Starting EPUB processing...');

        // Process EPUB content
        await processEpubContent(inputPath, outputPath);

        console.log('✅ EPUB processing completed successfully!');
    } catch (error) {
        console.error('❌ Error processing EPUB file:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

/**
 * Core EPUB processing logic
 */
async function processEpubContent(filePath: string, outputPath: string): Promise<void> {
    console.log(`📖 Analyzing EPUB structure: ${path.basename(filePath)}`);

    // Get file stats
    const stats = fs.statSync(filePath);
    console.log(`📊 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`📅 Last modified: ${stats.mtime.toLocaleDateString()}`);

    // Extract EPUB archive
    console.log('📦 Extracting EPUB archive...');
    const extractedContent = await extractEpubArchive(filePath);

    // Parse EPUB metadata and structure
    console.log('📋 Parsing EPUB metadata...');
    const epubMetadata = await parseEpubMetadata(extractedContent.entries);
    console.log(`📖 Book: ${epubMetadata.title || 'Unknown Title'}`);
    console.log(`👤 Author: ${epubMetadata.creator || 'Unknown Author'}`);
    console.log(`📄 OPF Location: ${epubMetadata.opfPath}`);

    // Classify content structure
    console.log('📚 Analyzing content structure...');
    const contentClassification = await classifyEpubContent(epubMetadata.spine, extractedContent.entries);


    // Log detailed classification results
    console.log('\n🔍 Content Classification Results:');
    console.log(JSON.stringify(contentClassification, null, 2));

    console.log(`  📄 Front matter: ${contentClassification.frontMatter.length} items`);
    if (contentClassification.prologue) {
        console.log(`  📖 Prologue: "${contentClassification.prologue.title || contentClassification.prologue.href}"`);
    }
    console.log(`  📚 Chapters: ${contentClassification.chapters.length} items`);
    if (contentClassification.epilogue) {
        console.log(`  📖 Epilogue: "${contentClassification.epilogue.title || contentClassification.epilogue.href}"`);
    }
    console.log(`  📄 Back matter: ${contentClassification.backMatter.length} items`);

    // Generate Obsidian output
    console.log('📝 Generating Obsidian output...');
    await generateObsidianOutput(extractedContent.entries, epubMetadata, outputPath, contentClassification);

    // /////////////////////////////////////////////////////////////////////////////
    // TODO: This is temporary
    // /////////////////////////////////////////////////////////////////////////////

    // Create extraction directory
    const extractDir = path.join(path.dirname(filePath), `${path.basename(filePath, '.epub')}_extracted`);
    console.log(`💾 Writing extracted files to: ${extractDir}`);

    // Write extracted files to disk
    await writeExtractedFiles(extractedContent.entries, extractDir);

    console.log(`✅ Extracted ${extractedContent.entries.length} files from EPUB`);
    console.log(`📁 Files available at: ${extractDir}`);

    // /////////////////////////////////////////////////////////////////////////////

    console.log('🔍 EPUB content analysis completed');
}

/**
 * Extract EPUB archive (ZIP file) and return its contents
 */
async function extractEpubArchive(filePath: string): Promise<{ entries: Array<{ fileName: string; content: Buffer; isDirectory: boolean; }>; }> {
    return new Promise((resolve, reject) => {
        const entries: Array<{ fileName: string; content: Buffer; isDirectory: boolean; }> = [];

        yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
            if (err) {
                reject(new Error(`Failed to open EPUB file: ${err.message}`));
                return;
            }

            if (!zipfile) {
                reject(new Error('Failed to open ZIP file'));
                return;
            }

            zipfile.readEntry();

            zipfile.on('entry', (entry) => {
                const fileName = entry.fileName;
                console.log(`  📄 Found: ${fileName}`);

                if (/\/$/.test(fileName)) {
                    // Directory entry
                    entries.push({ fileName, content: Buffer.alloc(0), isDirectory: true });
                    zipfile.readEntry();
                } else {
                    // File entry
                    zipfile.openReadStream(entry, (err, readStream) => {
                        if (err) {
                            reject(new Error(`Failed to read entry ${fileName}: ${err.message}`));
                            return;
                        }

                        if (!readStream) {
                            reject(new Error(`Failed to open read stream for ${fileName}`));
                            return;
                        }

                        const chunks: Buffer[] = [];
                        readStream.on('data', (chunk) => {
                            chunks.push(chunk);
                        });

                        readStream.on('end', () => {
                            const content = Buffer.concat(chunks);
                            entries.push({ fileName, content, isDirectory: false });
                            zipfile.readEntry();
                        });

                        readStream.on('error', (err) => {
                            reject(new Error(`Error reading ${fileName}: ${err.message}`));
                        });
                    });
                }
            });

            zipfile.on('end', () => {
                resolve({ entries });
            });

            zipfile.on('error', (err) => {
                reject(new Error(`ZIP file error: ${err.message}`));
            });
        });
    });
}

/**
 * Write extracted files to disk
 */
async function writeExtractedFiles(entries: Array<{ fileName: string; content: Buffer; isDirectory: boolean; }>, extractDir: string): Promise<void> {
    // Create base extraction directory
    if (!fs.existsSync(extractDir)) {
        fs.mkdirSync(extractDir, { recursive: true });
    }

    for (const entry of entries) {
        const fullPath = path.join(extractDir, entry.fileName);

        if (entry.isDirectory) {
            // Create directory
            if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(fullPath, { recursive: true });
            }
        } else {
            // Create parent directory if it doesn't exist
            const parentDir = path.dirname(fullPath);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }

            // Write file
            fs.writeFileSync(fullPath, entry.content);
            console.log(`  💾 Wrote: ${entry.fileName}`);
        }
    }
}

/**
 * Parse EPUB metadata from extracted content
 */
async function parseEpubMetadata(entries: Array<{ fileName: string; content: Buffer; isDirectory: boolean; }>): Promise<{
    opfPath: string;
    title?: string;
    creator?: string;
    language?: string;
    identifier?: string;
    spine: Array<{ id: string; href: string; }>;
    manifest: Map<string, { href: string; mediaType: string; }>;
}> {
    // Step 1: Parse container.xml to find OPF location
    const containerEntry = entries.find(entry => entry.fileName === 'META-INF/container.xml');
    if (!containerEntry) {
        throw new Error('META-INF/container.xml not found in EPUB');
    }

    const containerXml = containerEntry.content.toString('utf-8');
    const containerData = await xml2js.parseStringPromise(containerXml);

    const rootfiles = containerData?.container?.rootfiles?.[0]?.rootfile;
    if (!rootfiles || !Array.isArray(rootfiles) || rootfiles.length === 0) {
        throw new Error('No rootfile found in container.xml');
    }

    const opfPath = rootfiles[0].$['full-path'];
    console.log(`  📍 Container points to OPF: ${opfPath}`);

    // Step 2: Parse the OPF file
    const opfEntry = entries.find(entry => entry.fileName === opfPath);
    if (!opfEntry) {
        throw new Error(`OPF file not found: ${opfPath}`);
    }

    const opfXml = opfEntry.content.toString('utf-8');
    const opfData = await xml2js.parseStringPromise(opfXml);

    // Extract metadata
    const metadata = opfData?.package?.metadata?.[0];
    const title = metadata?.['dc:title']?.[0]?._ || metadata?.['dc:title']?.[0];
    const creator = metadata?.['dc:creator']?.[0]?._ || metadata?.['dc:creator']?.[0];
    const language = metadata?.['dc:language']?.[0]?._ || metadata?.['dc:language']?.[0];
    const identifier = metadata?.['dc:identifier']?.[0]?._ || metadata?.['dc:identifier']?.[0];

    // Extract manifest (list of all files with their metadata)
    const manifest = new Map<string, { href: string; mediaType: string; }>();
    const manifestItems = opfData?.package?.manifest?.[0]?.item || [];
    for (const item of manifestItems) {
        const id = item.$.id;
        const href = item.$.href;
        const mediaType = item.$['media-type'];
        manifest.set(id, { href, mediaType });
    }

    // Extract spine (reading order)
    const spine: Array<{ id: string; href: string; }> = [];
    const spineItems = opfData?.package?.spine?.[0]?.itemref || [];
    for (const itemref of spineItems) {
        const idref = itemref.$.idref;
        const manifestItem = manifest.get(idref);
        if (manifestItem) {
            spine.push({ id: idref, href: manifestItem.href });
        }
    }

    console.log(`  📚 Found ${manifest.size} manifest items`);
    console.log(`  📖 Reading order: ${spine.length} chapters`);

    return {
        opfPath,
        title,
        creator,
        language,
        identifier,
        spine,
        manifest
    };
}

/**
 * Content classification types
 */
interface ContentClassification {
    frontMatter: Array<{ id: string; href: string; title?: string; }>;
    prologue?: { id: string; href: string; title?: string; };
    chapters: Array<{ id: string; href: string; title?: string; chapterNumber: number; }>;
    epilogue?: { id: string; href: string; title?: string; };
    backMatter: Array<{ id: string; href: string; title?: string; }>;
}

/**
 * Classify EPUB content based on structure and order
 */
async function classifyEpubContent(
    spine: Array<{ id: string; href: string; }>,
    entries: Array<{ fileName: string; content: Buffer; isDirectory: boolean; }>
): Promise<ContentClassification> {
    const classification: ContentClassification = {
        frontMatter: [],
        chapters: [],
        backMatter: []
    };

    // Extract title and analyze content patterns
    const analyzeContent = (content: string): {
        title?: string;
        hasSubstantialText: boolean;
        patterns: string[];
        wordCount: number;
        calibreChapterNumber?: number;
    } => {
        // Extract calibre chapter information from h1.chap_n elements (do this first)
        const calibreChapterMatch = content.match(/<h1[^>]*class="chap_n"[^>]*>.*?\[(\d+)\]/s);
        const calibreChapterNumber = calibreChapterMatch ? parseInt(calibreChapterMatch[1]) : undefined;
        
        // Extract the full calibre chapter title by getting text content from h1.chap_n
        let calibreFullTitle: string | undefined;
        if (calibreChapterNumber !== undefined) {
            const h1Match = content.match(/<h1[^>]*class="chap_n"[^>]*>(.*?)<\/h1>/s);
            if (h1Match) {
                // Remove HTML tags but keep the text content
                const h1Content = h1Match[1].replace(/<[^>]*>/g, '').trim();
                if (h1Content.includes(`[${calibreChapterNumber}]`)) {
                    calibreFullTitle = h1Content;
                }
            }
        }

        // Extract title from various sources, but be smart about it
        const titleMatches = [
            content.match(/<title[^>]*>([^<]+)<\/title>/i),
            content.match(/<h1[^>]*>([^<]+)<\/h1>/i),
            content.match(/<h2[^>]*>([^<]+)<\/h2>/i),
            content.match(/<h3[^>]*>([^<]+)<\/h3>/i)
        ];

        // Analyze patterns first to determine content type
        const textContent = content
            .replace(/<[^>]*>/g, ' ') // Remove HTML tags
            .replace(/\s+/g, ' ') // Normalize whitespace
            .trim();

        const lowerContent = content.toLowerCase();
        const lowerText = textContent.toLowerCase();

        // Check for structural content types
        const isEpilogue = lowerText.match(/^(epilogue|épilogue|conclusion|postface)/) || 
                         (lowerContent.includes('<h1') && lowerContent.includes('épilogue'));
        const isPrologue = lowerText.match(/^(prologue|préface|avant-propos|introduction)/) || 
                         (lowerContent.includes('<h1') && lowerContent.includes('prologue'));

        let title: string | undefined;
        
        // Priority 1: If we have a full calibre title (like "[116]"), use that
        if (calibreFullTitle) {
            title = calibreFullTitle;
        }
        // Priority 2: If we have calibre chapter numbers but no full title, use generic chapter format
        else if (calibreChapterNumber !== undefined) {
            title = `Chapter ${calibreChapterNumber}`;
        }
        // Priority 3: For structural content (epilogue/prologue), use generic titles
        else if (isEpilogue) {
            title = 'Epilogue';
        } else if (isPrologue) {
            title = 'Prologue';
        } 
        // Priority 4: Extract title from content, but be smart about what we accept
        else {
            for (const match of titleMatches) {
                if (match?.[1]) {
                    const candidateTitle = match[1].trim().replace(/&[^;]+;/g, ''); // Basic HTML entity cleanup
                    
                    // Skip titles that look like dates or preliminary content for main chapters
                    const isDateLike = /^\w+\s+\d{1,2}\s+\w+\s+\d{4}$/.test(candidateTitle); // "Friday 22 November 2013"
                    const isTimeLike = /^\w+\s+mois\s+plus\s+tard$/.test(candidateTitle); // "Sept mois plus tard"
                    
                    // Accept the first reasonable title we find
                    if (!isDateLike && !isTimeLike) {
                        title = candidateTitle;
                        break;
                    }
                }
            }
        }

        // Clean text content for analysis (reuse variables from above)
        const wordCount = textContent.split(/\s+/).filter(word => word.length > 0).length;
        const hasSubstantialText = wordCount > 50; // More than 50 words indicates substantial content

        // Detect patterns in content and structure
        const patterns: string[] = [];

        // Structural patterns
        if (lowerContent.includes('pagetitre') || lowerContent.includes('auteur_ident')) patterns.push('title-page');
        if (lowerContent.includes('copyright') || lowerContent.includes('pagecopyright')) patterns.push('copyright');
        if (lowerContent.includes('exergues') || lowerContent.includes('epigraph')) patterns.push('epigraph');
        if (lowerContent.includes('toc') || lowerContent.includes('table') || lowerText.includes('sommaire')) patterns.push('toc');
        if (lowerContent.includes('dedication') || lowerText.includes('dédicace')) patterns.push('dedication');

        // Content-based patterns
        if (lowerText.match(/^(prologue|préface|avant-propos|introduction)/)) patterns.push('prologue');
        if (lowerText.match(/^(epilogue|épilogue|conclusion|postface)/)) patterns.push('epilogue');
        if (lowerText.includes('chapitre') || lowerText.includes('chapter')) patterns.push('chapter-marker');

        // Calibre-specific patterns
        if (content.includes('class="chap_n"')) patterns.push('calibre-chapter-marker');
        if (calibreChapterNumber !== undefined) patterns.push('calibre-numbered-chapter');

        // Structural epilogue/prologue headers (title-only pages)
        if (lowerContent.includes('<h1') && lowerContent.includes('épilogue')) patterns.push('epilogue-header');
        if (lowerContent.includes('<h1') && lowerContent.includes('prologue')) patterns.push('prologue-header');

        // Image-heavy content (likely front matter)
        const imageCount = (content.match(/<img[^>]*>/g) || []).length;
        if (imageCount > 0 && wordCount < 20) patterns.push('image-heavy');

        return { title, hasSubstantialText, patterns, wordCount, calibreChapterNumber };
    };

    // Analyze each spine item
    const spineWithAnalysis = await Promise.all(spine.map(async (spineItem, index) => {
        const entry = entries.find(e => e.fileName.includes(spineItem.href) && !e.isDirectory);
        let analysis = { title: undefined as string | undefined, hasSubstantialText: false, patterns: [] as string[], wordCount: 0, calibreChapterNumber: undefined as number | undefined };

        if (entry) {
            try {
                const content = entry.content.toString('utf-8');
                const contentAnalysis = analyzeContent(content);
                analysis = {
                    title: contentAnalysis.title,
                    hasSubstantialText: contentAnalysis.hasSubstantialText,
                    patterns: contentAnalysis.patterns,
                    wordCount: contentAnalysis.wordCount,
                    calibreChapterNumber: contentAnalysis.calibreChapterNumber
                };
            } catch (error) {
                console.warn(`Warning: Could not read content from ${spineItem.href}`);
            }
        }

        return { ...spineItem, analysis, originalIndex: index };
    }));

    // Find the transition points based on structure and content
    const totalItems = spineWithAnalysis.length;
    let mainContentStart = 0;
    let mainContentEnd = totalItems - 1;

    // Identify front matter boundary
    for (let i = 0; i < Math.min(10, totalItems); i++) {
        const item = spineWithAnalysis[i];
        const { patterns, hasSubstantialText, wordCount } = item.analysis;

        // If this item has substantial content and no front matter patterns, main content starts here
        if (hasSubstantialText &&
            wordCount > 200 && // Significant word count
            !patterns.some(p => ['title-page', 'copyright', 'epigraph', 'toc', 'dedication', 'image-heavy'].includes(p))) {
            mainContentStart = i;
            break;
        }

        // Special handling for items with prologue patterns
        if (patterns.includes('prologue')) {
            mainContentStart = i;
            break;
        }
    }

    // Identify back matter boundary (work backwards)
    for (let i = totalItems - 1; i >= Math.max(totalItems - 10, mainContentStart); i--) {
        const item = spineWithAnalysis[i];
        const { patterns, hasSubstantialText, wordCount } = item.analysis;

        // If this item has substantial content and no back matter patterns, main content ends here
        if (hasSubstantialText &&
            wordCount > 200 &&
            !patterns.some(p => ['epilogue', 'acknowledgment', 'bibliography', 'index'].includes(p))) {
            mainContentEnd = i;
            break;
        }

        // Special handling for items with epilogue patterns
        if (patterns.includes('epilogue')) {
            mainContentEnd = i;
            break;
        }
    }

    // Classify front matter
    for (let i = 0; i < mainContentStart; i++) {
        const item = spineWithAnalysis[i];
        classification.frontMatter.push({
            id: item.id,
            href: item.href,
            title: item.analysis.title
        });
    }

    // Classify back matter
    for (let i = mainContentEnd + 1; i < totalItems; i++) {
        const item = spineWithAnalysis[i];
        classification.backMatter.push({
            id: item.id,
            href: item.href,
            title: item.analysis.title
        });
    }

    // Analyze main content section for prologue, chapters, and epilogue
    const mainContentItems = spineWithAnalysis.slice(mainContentStart, mainContentEnd + 1);

    // Check for prologue in main content
    const firstMainItem = mainContentItems[0];
    if (firstMainItem?.analysis.patterns.includes('prologue') || firstMainItem?.analysis.patterns.includes('prologue-header')) {
        classification.prologue = {
            id: firstMainItem.id,
            href: firstMainItem.href,
            title: firstMainItem.analysis.title
        };
        mainContentItems.shift(); // Remove from main content
    }

    // Check for epilogue in main content (can be header + content or just content)
    // Look for epilogue header pattern first
    for (let i = mainContentItems.length - 3; i < mainContentItems.length; i++) {
        if (i >= 0 && mainContentItems[i]?.analysis.patterns.includes('epilogue-header')) {
            // Found epilogue header, check if next item exists and treat it as epilogue content
            if (i + 1 < mainContentItems.length) {
                classification.epilogue = {
                    id: mainContentItems[i + 1].id,
                    href: mainContentItems[i + 1].href,
                    title: mainContentItems[i + 1].analysis.title
                };
                // Remove both header and content from main content
                mainContentItems.splice(i, 2);
            } else {
                // Just the header, treat it as epilogue
                classification.epilogue = {
                    id: mainContentItems[i].id,
                    href: mainContentItems[i].href,
                    title: mainContentItems[i].analysis.title
                };
                mainContentItems.splice(i, 1);
            }
            break;
        }
    }

    // If no epilogue header found, check for direct epilogue patterns
    if (!classification.epilogue) {
        const lastMainItem = mainContentItems[mainContentItems.length - 1];
        if (lastMainItem?.analysis.patterns.includes('epilogue')) {
            classification.epilogue = {
                id: lastMainItem.id,
                href: lastMainItem.href,
                title: lastMainItem.analysis.title
            };
            mainContentItems.pop(); // Remove from main content
        }
    }

    // Remaining items are chapters - handle calibre numbering and content pairing
    const chapterItems: Array<{
        id: string;
        href: string;
        title?: string;
        chapterNumber: number;
    }> = [];

    // Build a map of calibre chapter numbers to items
    const calibreChapterMap = new Map<number, typeof mainContentItems[0]>();
    const unNumberedItems: typeof mainContentItems = [];

    for (const item of mainContentItems) {
        if (item.analysis.calibreChapterNumber !== undefined) {
            calibreChapterMap.set(item.analysis.calibreChapterNumber, item);
        } else {
            unNumberedItems.push(item);
        }
    }

    // Process calibre-numbered chapters
    const sortedCalibreNumbers = Array.from(calibreChapterMap.keys()).sort((a, b) => a - b);
    
    for (let i = 0; i < sortedCalibreNumbers.length; i++) {
        const calibreNum = sortedCalibreNumbers[i];
        const markerItem = calibreChapterMap.get(calibreNum)!;
        
        // Check if this is just a chapter marker (minimal content) or actual chapter content
        const isJustMarker = markerItem.analysis.wordCount < 200 && 
                            markerItem.analysis.patterns.includes('calibre-chapter-marker');
        
        if (isJustMarker) {
            // This is a chapter marker, look for the next unnumbered item as the content
            const nextContentItem = unNumberedItems.find(item => 
                item.originalIndex > markerItem.originalIndex && 
                item.analysis.hasSubstantialText &&
                item.analysis.wordCount > 200
            );
            
            if (nextContentItem) {
                // Use the content item but with the calibre chapter number and title from marker
                chapterItems.push({
                    id: nextContentItem.id,
                    href: nextContentItem.href,
                    title: markerItem.analysis.title || `[${calibreNum}]`, // Use marker title, fallback to [X]
                    chapterNumber: calibreNum
                });
                
                // Remove the content item from unnumbered items to avoid double processing
                const contentIndex = unNumberedItems.indexOf(nextContentItem);
                if (contentIndex > -1) {
                    unNumberedItems.splice(contentIndex, 1);
                }
            } else {
                // No content found, use the marker itself
                chapterItems.push({
                    id: markerItem.id,
                    href: markerItem.href,
                    title: markerItem.analysis.title || `[${calibreNum}]`, // Use marker title, fallback to [X]
                    chapterNumber: calibreNum
                });
            }
        } else {
            // This item has both the marker and substantial content
            chapterItems.push({
                id: markerItem.id,
                href: markerItem.href,
                title: markerItem.analysis.title,
                chapterNumber: calibreNum
            });
        }
    }

    // Handle any remaining unnumbered items as additional chapters
    let nextChapterNumber = sortedCalibreNumbers.length > 0 ? Math.max(...sortedCalibreNumbers) + 1 : 1;
    for (const item of unNumberedItems) {
        if (item.analysis.hasSubstantialText && item.analysis.wordCount > 200) {
            chapterItems.push({
                id: item.id,
                href: item.href,
                title: item.analysis.title,
                chapterNumber: nextChapterNumber++
            });
        }
    }

    // Sort chapters by their calibre chapter number
    chapterItems.sort((a, b) => a.chapterNumber - b.chapterNumber);
    classification.chapters = chapterItems;

    return classification;
}

/**
 * Generate Obsidian-compatible output from EPUB
 */
async function generateObsidianOutput(
    entries: Array<{ fileName: string; content: Buffer; isDirectory: boolean; }>,
    metadata: {
        title?: string;
        creator?: string;
        language?: string;
        identifier?: string;
        opfPath: string;
        spine: Array<{ id: string; href: string; }>;
        manifest: Map<string, { href: string; mediaType: string; }>;
    },
    outputPath: string,
    contentClassification: ContentClassification
): Promise<void> {
    // Sanitize title for folder name
    const sanitizedTitle = sanitizeFileName(metadata.title || 'Unknown Title');
    const bookDir = path.join(outputPath, sanitizedTitle);

    // Create output directory
    if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
    }
    if (!fs.existsSync(bookDir)) {
        fs.mkdirSync(bookDir, { recursive: true });
    }

    console.log(`📁 Creating book directory: ${bookDir}`);

    // Extract cover image
    const coverFileName = await extractCoverImage(entries, metadata, bookDir);

    // Generate main book note
    await generateBookNote(metadata, bookDir, coverFileName, contentClassification);

    // Process and generate chapter content
    await processChapterContent(entries, contentClassification, bookDir, metadata.title || 'Unknown Title');

    console.log(`✅ Obsidian output generated successfully!`);
}

/**
 * Sanitize filename for cross-platform compatibility
 */
function sanitizeFileName(name: string): string {
    return name
        .replace(/[<>:"/\\|?*]/g, '-')  // Replace invalid characters
        .replace(/\s+/g, ' ')           // Normalize whitespace
        .trim()                         // Remove leading/trailing spaces
        .replace(/\.$/, '')             // Remove trailing period
        .substring(0, 255);             // Limit length
}

/**
 * Extract cover image to the book directory
 */
async function extractCoverImage(
    entries: Array<{ fileName: string; content: Buffer; isDirectory: boolean; }>,
    metadata: {
        title?: string;
        manifest: Map<string, { href: string; mediaType: string; }>;
    },
    bookDir: string
): Promise<string | null> {
    // Look for cover image in manifest
    let coverImageEntry: { fileName: string; content: Buffer; } | undefined;

    // Try to find cover by common names
    const possibleCoverNames = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.gif'];

    for (const coverName of possibleCoverNames) {
        coverImageEntry = entries.find(entry =>
            entry.fileName.toLowerCase().includes(coverName.toLowerCase()) && !entry.isDirectory
        );
        if (coverImageEntry) break;
    }

    // If not found by name, look for images in root or images folder
    if (!coverImageEntry) {
        coverImageEntry = entries.find(entry =>
            !entry.isDirectory &&
            (entry.fileName.endsWith('.jpg') ||
                entry.fileName.endsWith('.jpeg') ||
                entry.fileName.endsWith('.png') ||
                entry.fileName.endsWith('.gif')) &&
            (entry.fileName.split('/').length <= 2) // Root or one level deep
        );
    }

    if (coverImageEntry) {
        const originalExt = path.extname(coverImageEntry.fileName);
        const sanitizedTitle = sanitizeFileName(metadata.title || 'Unknown Title');
        const coverFileName = `${sanitizedTitle}${originalExt}`;
        const coverPath = path.join(bookDir, coverFileName);

        fs.writeFileSync(coverPath, coverImageEntry.content);
        console.log(`🖼️ Extracted cover: ${coverFileName}`);
        return coverFileName;
    } else {
        console.log(`⚠️ No cover image found`);
        return null;
    }
}

/**
 * Generate the main book note in Obsidian format
 */
async function generateBookNote(
    metadata: {
        title?: string;
        creator?: string;
        language?: string;
        identifier?: string;
        spine: Array<{ id: string; href: string; }>;
    },
    bookDir: string,
    coverFileName?: string | null,
    contentClassification?: ContentClassification
): Promise<void> {
    const sanitizedTitle = sanitizeFileName(metadata.title || 'Unknown Title');
    const noteFileName = `${sanitizedTitle}.md`;
    const notePath = path.join(bookDir, noteFileName);

    // Generate Obsidian-formatted metadata
    let obsidianNote = `---
title: "${metadata.title || 'Unknown Title'}"
author: "${metadata.creator || 'Unknown Author'}"
language: "${metadata.language || 'Unknown'}"
identifier: "${metadata.identifier || 'Unknown'}"
type: book
source: epub
chapters: ${contentClassification?.chapters.length || metadata.spine.length}
imported: ${new Date().toISOString().split('T')[0]}${coverFileName ? `\ncover: "[[${coverFileName}]]"` : ''}
---

# ${metadata.title || 'Unknown Title'}
`;

    // Add content structure if available
    if (contentClassification) {
        // Add chapters list with prologue and epilogue included
        obsidianNote += `\n## Table of Contents\n\n`;
        
        // Add prologue if exists
        if (contentClassification.prologue) {
            const prologueTitle = contentClassification.prologue.title || 'Prologue';
            const prologueFileName = `${sanitizedTitle} - ${sanitizeFileName(prologueTitle)}`;
            obsidianNote += `**Prologue**: [[${prologueFileName}]]\n`;
        }
        
        // Add all chapters
        contentClassification.chapters.forEach((chapter, index) => {
            const chapterNumber = chapter.chapterNumber || index + 1;
            const chapterFileName = `${sanitizedTitle} - Chapter ${chapterNumber}`;
            obsidianNote += `${chapterNumber}. [[${chapterFileName}]]\n`;
        });
        
        // Add epilogue if exists
        if (contentClassification.epilogue) {
            const epilogueTitle = contentClassification.epilogue.title || 'Epilogue';
            const epilogueFileName = `${sanitizedTitle} - ${sanitizeFileName(epilogueTitle)}`;
            obsidianNote += `**Epilogue**: [[${epilogueFileName}]]\n`;
        }
    }

    fs.writeFileSync(notePath, obsidianNote);
    console.log(`📝 Generated book note: ${noteFileName}`);
}

/**
 * Process chapter content and convert to Obsidian format using calibre markup
 */
async function processChapterContent(
    entries: Array<{ fileName: string; content: Buffer; isDirectory: boolean; }>,
    contentClassification: ContentClassification,
    bookDir: string,
    bookTitle: string
): Promise<void> {
    console.log(`📚 Processing ${contentClassification.chapters.length} chapters...`);

    // Process prologue if exists
    if (contentClassification.prologue) {
        await processContentFile(
            entries,
            contentClassification.prologue.href,
            contentClassification.prologue.title || 'Prologue',
            bookDir,
            'prologue',
            undefined,
            bookTitle
        );
    }

    // Process each chapter
    for (const chapter of contentClassification.chapters) {
        const chapterTitle = chapter.title || `Chapter ${chapter.chapterNumber}`;
        await processContentFile(
            entries,
            chapter.href,
            chapterTitle,
            bookDir,
            'chapter',
            chapter.chapterNumber,
            bookTitle
        );
    }

    // Process epilogue if exists
    if (contentClassification.epilogue) {
        await processContentFile(
            entries,
            contentClassification.epilogue.href,
            contentClassification.epilogue.title || 'Epilogue',
            bookDir,
            'epilogue',
            undefined,
            bookTitle
        );
    }

    console.log(`✅ Processed all chapter content`);
}

/**
 * Process a single content file and convert to Obsidian Markdown
 */
async function processContentFile(
    entries: Array<{ fileName: string; content: Buffer; isDirectory: boolean; }>,
    href: string,
    title: string,
    bookDir: string,
    type: 'prologue' | 'chapter' | 'epilogue',
    chapterNumber?: number,
    bookTitle?: string
): Promise<void> {
    // Find the content entry
    const entry = entries.find(e => e.fileName.includes(href) && !e.isDirectory);
    if (!entry) {
        console.warn(`⚠️ Content file not found: ${href}`);
        return;
    }

    try {
        const content = entry.content.toString('utf-8');
        const markdownContent = convertCalibreToMarkdown(content, title, type, chapterNumber, bookTitle);
        
        // Generate proper filename based on type
        let noteFileName: string;
        const sanitizedBookTitle = sanitizeFileName(bookTitle || 'Book');
        
        if (type === 'prologue') {
            noteFileName = `${sanitizedBookTitle} - Prologue.md`;
        } else if (type === 'epilogue') {
            noteFileName = `${sanitizedBookTitle} - Epilogue.md`;
        } else if (type === 'chapter' && chapterNumber) {
            noteFileName = `${sanitizedBookTitle} - Chapter ${chapterNumber}.md`;
        } else {
            // Fallback
            const sanitizedTitle = sanitizeFileName(title);
            noteFileName = `${sanitizedTitle}.md`;
        }
        
        const notePath = path.join(bookDir, noteFileName);
        
        fs.writeFileSync(notePath, markdownContent);
        console.log(`📄 Generated ${type}: ${noteFileName}`);
    } catch (error) {
        console.error(`❌ Error processing ${href}:`, error);
    }
}

/**
 * Convert Calibre XHTML content to Obsidian Markdown using calibre markup patterns
 */
function convertCalibreToMarkdown(
    content: string,
    title: string,
    type: 'prologue' | 'chapter' | 'epilogue',
    chapterNumber?: number,
    bookTitle?: string
): string {
    let markdown = '';

    // Add frontmatter
    markdown += `---\n`;
    markdown += `title: "${title}"\n`;
    markdown += `type: ${type}\n`;
    if (chapterNumber) {
        markdown += `chapter: ${chapterNumber}\n`;
    }
    if (bookTitle) {
        markdown += `book: "${bookTitle}"\n`;
    }
    markdown += `source: epub\n`;
    markdown += `---\n\n`;

    // Add title
    markdown += `# ${title}\n\n`;

    // Extract main content by removing HTML tags but preserving structure
    let textContent = content;

    // Remove HTML structure but preserve calibre hints
    textContent = textContent
        .replace(/<\?xml[^>]*\?>/g, '') // Remove XML declaration
        .replace(/<html[^>]*>/g, '') // Remove html tag
        .replace(/<\/html>/g, '') // Remove closing html tag
        .replace(/<head>.*?<\/head>/gs, '') // Remove head section
        .replace(/<body[^>]*>/g, '') // Remove body tag
        .replace(/<\/body>/g, '') // Remove closing body tag
        .replace(/<div[^>]*class="exergues"[^>]*>/g, '') // Remove chapter container
        .replace(/<div[^>]*class="pagetitre"[^>]*><\/div>/g, '') // Remove page title divs
        .replace(/<h1[^>]*class="chap_n"[^>]*>.*?<\/h1>/gs, '') // Remove chapter number headers
        .replace(/<div[^>]*class="dev"[^>]*>/g, '') // Remove dev containers
        .replace(/<\/div>/g, '') // Remove closing divs

    // Convert calibre text classes to markdown
    textContent = textContent
        // Convert paragraph with first letter styling
        .replace(/<p class="txt_courant_ssalinea"><span class="let">([^<]*)<\/span>([^<]*)<\/p>/g, '**$1**$2\n\n')
        // Convert regular paragraphs
        .replace(/<p class="txt_courant_[^"]*">([^<]*)<\/p>/g, '$1\n\n')
        // Convert justified paragraphs
        .replace(/<p class="txt_courant_justif">([^<]*)<\/p>/g, '$1\n\n')
        // Convert italic text
        .replace(/<i class="calibre2">([^<]*)<\/i>/g, '*$1*')
        // Remove page anchors (no longer needed per requirements)
        .replace(/<a id="page_(\d+)" class="calibre4"><\/a>/g, '')

    // Handle special content blocks like letters
    textContent = textContent
        .replace(/<div class="lettre">/g, '\n> **Letter/Email:**\n> ')
        .replace(/<\/div>/g, '\n\n')

    // Clean up remaining HTML tags
    textContent = textContent
        .replace(/<[^>]*>/g, '') // Remove any remaining HTML tags
        .replace(/&[^;]+;/g, '') // Remove HTML entities (basic cleanup)
        .replace(/\n\s*\n\s*\n/g, '\n\n') // Normalize multiple newlines
        .trim();

    markdown += textContent;

    return markdown;
}

// Parse command line arguments and execute
export function runCLI(): void {
    program.parse();
}

if (require.main === module) {
    runCLI();
}