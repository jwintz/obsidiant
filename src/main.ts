#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as yauzl from 'yauzl';
import { promisify } from 'util';
import * as xml2js from 'xml2js';

const program = new Command();

// Interface for part title information from navigation files
interface PartTitleInfo {
    partNumber: number;
    title: string;
    href: string;
}

// Function to parse navigation file and extract part titles
async function parseNavigationFile(zipFile: yauzl.ZipFile): Promise<Map<number, string>> {
    const partTitles = new Map<number, string>();

    return new Promise((resolve) => {
        zipFile.readEntry();

        zipFile.on('entry', (entry) => {
            // Look for navigation files
            if (entry.fileName.match(/\.xhtml$/) && (
                entry.fileName.includes('nav') ||
                entry.fileName.includes('toc') ||
                entry.fileName.toLowerCase().includes('navigation')
            )) {
                zipFile.openReadStream(entry, (err, readStream) => {
                    if (err) {
                        console.log(`Error reading navigation file ${entry.fileName}:`, err);
                        zipFile.readEntry();
                        return;
                    }

                    let content = '';
                    readStream.on('data', (chunk) => {
                        content += chunk.toString();
                    });

                    readStream.on('end', () => {
                        // Extract part titles from navigation content
                        // Look for patterns like: <a href="...">Partie 5. Deux femmes d'action déterminées</a>
                        const partMatches = content.matchAll(/<a[^>]*href="[^"]*"[^>]*>Partie\s+(\d+)\.\s*([^<]+)<\/a>/gi);

                        for (const match of partMatches) {
                            const partNumber = parseInt(match[1]);
                            const partTitle = `Partie ${partNumber}. ${match[2].trim()}`;
                            partTitles.set(partNumber, partTitle);
                            console.log(`📖 Found part title in navigation: ${partTitle}`);
                        }

                        zipFile.readEntry();
                    });
                });
            } else {
                zipFile.readEntry();
            }
        });

        zipFile.on('end', () => {
            resolve(partTitles);
        });
    });
}

// Function to extract part titles from navigation files in entries
async function extractPartTitlesFromNavigation(entries: Array<{ fileName: string; content: Buffer; isDirectory: boolean; }>): Promise<Map<number, string>> {
    const partTitles = new Map<number, string>();

    // Look for navigation files in entries
    for (const entry of entries) {
        if (entry.isDirectory) continue;

        // Look for navigation files
        if (entry.fileName.match(/\.xhtml$/) && (
            entry.fileName.includes('nav') ||
            entry.fileName.includes('toc') ||
            entry.fileName.toLowerCase().includes('navigation')
        )) {
            const content = entry.content.toString('utf-8');

            // Extract part titles from navigation content
            // Look for patterns like: <a href="...">Partie 5. Deux femmes d'action déterminées</a>
            const partMatches = content.matchAll(/<a[^>]*href="[^"]*"[^>]*>Partie\s+(\d+)\.\s*([^<]+)<\/a>/gi);

            for (const match of partMatches) {
                const partNumber = parseInt(match[1]);
                const partTitle = `Partie ${partNumber}. ${match[2].trim()}`;
                partTitles.set(partNumber, partTitle);
                console.log(`📖 Found part title in navigation: ${partTitle}`);
            }
        }
    }

    return partTitles;
}

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

    // Parse navigation files for part titles
    console.log('📖 Parsing navigation files for part titles...');
    const navigationPartTitles = await extractPartTitlesFromNavigation(extractedContent.entries);

    // Parse EPUB metadata and structure
    console.log('📋 Parsing EPUB metadata...');
    const epubMetadata = await parseEpubMetadata(extractedContent.entries);
    console.log(`📖 Book: ${epubMetadata.title || 'Unknown Title'}`);
    console.log(`👤 Author: ${epubMetadata.creator || 'Unknown Author'}`);
    console.log(`📄 OPF Location: ${epubMetadata.opfPath}`);

    // Classify content structure
    console.log('📚 Analyzing content structure...');
    const contentClassification = await classifyEpubContent(epubMetadata.spine, extractedContent.entries, navigationPartTitles);


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

    // // Create extraction directory
    // const extractDir = path.join(path.dirname(filePath), `${path.basename(filePath, '.epub')}_extracted`);
    // console.log(`💾 Writing extracted files to: ${extractDir}`);

    // // Write extracted files to disk
    // await writeExtractedFiles(extractedContent.entries, extractDir);

    // console.log(`✅ Extracted ${extractedContent.entries.length} files from EPUB`);
    // console.log(`📁 Files available at: ${extractDir}`);

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
    chapters: Array<{ id: string; href: string; title?: string; chapterNumber: number; partNumber?: number; partTitle?: string; content?: string; }>;
    epilogue?: { id: string; href: string; title?: string; };
    backMatter: Array<{ id: string; href: string; title?: string; }>;
}

function extractInternalChapters(content: string, item: any, partNumber: number, partTitle: string): any[] {
    const chapters: any[] = [];

    console.log(`    🔍 Extracting chapters from ${item.href}...`);

    // Look for <h1 class="level1_title"> markers which indicate chapter boundaries
    const chapterPattern = /<h1[^>]*class="[^"]*level1_title[^"]*"[^>]*>(.*?)<\/h1>/gi;
    const matches = Array.from(content.matchAll(chapterPattern));

    console.log(`    📊 Found ${matches.length} internal chapters`);

    if (matches.length === 0) {
        return []; // No internal chapters found
    }

    // For this multipart book format, numbered chapters "1.", "2.", etc. ARE legitimate chapter titles
    // Only filter out if there are both numbered (1., 2.) AND named chapters (Chapter 1, etc.) 
    // and the numbered ones are clearly subsections
    const numberedTitles = matches.filter(m => /^\d+\.$/.test(m[1].trim()));
    const namedTitles = matches.filter(m => !/^\d+\.$/.test(m[1].trim()));

    let validChapterMatches = matches;

    // Only filter out numbered titles if we have substantial named titles that suggest
    // the numbered ones are subsections
    if (namedTitles.length > numberedTitles.length / 2) {
        console.log(`    🔄 Filtering out ${numberedTitles.length} numbered subsections, keeping ${namedTitles.length} named chapters`);
        validChapterMatches = namedTitles;
        for (const match of numberedTitles) {
            console.log(`    🔄 Skipping numbered subsection: "${match[1].trim()}"`);
        }
    } else {
        console.log(`    ✅ Keeping all ${matches.length} chapters (numbered chapters appear to be legitimate)`);
    }

    console.log(`    📊 Found ${validChapterMatches.length} valid chapters after filtering`);

    if (validChapterMatches.length === 0) {
        return []; // No valid chapters found after filtering
    }

    // Split content by actual chapter markers - include numbered chapters if they're legitimate
    const actualChapterPattern = validChapterMatches === matches
        ? /<h1[^>]*class="[^"]*level1_title[^"]*"[^>]*>(.*?)<\/h1>/gi  // Include all if numbered are legitimate
        : /<h1[^>]*class="[^"]*level1_title[^"]*"[^>]*>(?!\d+\.)(.*?)<\/h1>/gi; // Exclude numbered if they're subsections
    const chapterSections = content.split(actualChapterPattern);

    console.log(`    📄 Split into ${chapterSections.length} sections`);

    // The split creates an array where odd indices contain the titles and even indices contain the content
    // chapterSections[0] is content before first chapter
    // chapterSections[1] is first chapter title, chapterSections[2] is first chapter content
    // chapterSections[3] is second chapter title, chapterSections[4] is second chapter content, etc.

    for (let i = 1; i < chapterSections.length; i += 2) {
        if (i + 1 < chapterSections.length) {
            const chapterTitle = chapterSections[i].trim();
            const chapterContent = chapterSections[i + 1];
            const chapterIndex = Math.floor(i / 2) + 1;

            console.log(`    📖 Chapter ${chapterIndex}: "${chapterTitle}"`);

            // Extract chapter number from title if possible (e.g., "1. Chapter Title" or "Chapter 1")
            const numberMatch = chapterTitle.match(/^\d+/) || chapterTitle.match(/chapitre\s+(\d+)/i) || chapterTitle.match(/chapter\s+(\d+)/i);
            const chapterNumber = numberMatch ? parseInt(numberMatch[0]) : chapterIndex;

            chapters.push({
                id: `${item.id}_ch${chapterNumber}`,
                href: item.href,
                title: chapterTitle || `Chapter ${chapterNumber}`,
                chapterNumber: chapterNumber,
                partNumber: partNumber,
                partTitle: partTitle,
                content: chapterContent
            });
        }
    }

    console.log(`    ✅ Extracted ${chapters.length} chapters from ${item.href}`);
    return chapters;
}

/**
 * Classify EPUB content based on structure and order
 */
async function classifyEpubContent(
    spine: Array<{ id: string; href: string; }>,
    entries: Array<{ fileName: string; content: Buffer; isDirectory: boolean; }>,
    navigationPartTitles: Map<number, string>
): Promise<ContentClassification> {
    const classification: ContentClassification = {
        frontMatter: [],
        chapters: [],
        backMatter: []
    };

    // Extract title and analyze content patterns
    const analyzeContent = (content: string, fileName?: string): {
        title?: string;
        hasSubstantialText: boolean;
        patterns: string[];
        wordCount: number;
        chapterNumber?: number;
        partNumber?: number;
        partTitle?: string;
    } => {
        // Extract calibre chapter information from h1.chapn elements (do this first)
        const calibreChapterMatch = content.match(/<h1[^>]*class="chapn"[^>]*>(.*?)<\/h1>/s) ||
            content.match(/<h1[^>]*class="chap_n"[^>]*>(.*?)<\/h1>/s);
        let chapterNumber: number | undefined;
        if (calibreChapterMatch) {
            // Extract just the number from the h1 content, ignoring HTML tags
            const h1Text = calibreChapterMatch[1].replace(/<[^>]*>/g, '').trim();
            // Handle both plain numbers (31) and bracketed numbers ([1])
            const numberMatch = h1Text.match(/^(\d+)$/) || h1Text.match(/^\[(\d+)\]$/);
            chapterNumber = numberMatch ? parseInt(numberMatch[1]) : undefined;
        }

        // Extract part information from part headers
        let partNumber: number | undefined;
        let partTitle: string | undefined;

        // Check filename for part patterns (like c05_part_cut1.xhtml, c06_part_cut1.xhtml)
        if (fileName) {
            const filePartMatch = fileName.match(/c(\d+)_part_cut(\d+)\.xhtml/);
            if (filePartMatch) {
                const filePartNumber = parseInt(filePartMatch[1]);

                // Map file part numbers to navigation part numbers
                // Files c05-c12 map to navigation parts 1-8
                const navigationPartNumber = filePartNumber - 4; // c05 -> 1, c06 -> 2, etc.

                // Check if we have a navigation title for this mapped part
                const navTitle = navigationPartTitles.get(navigationPartNumber);
                if (navTitle) {
                    partNumber = navigationPartNumber; // Use the mapped number
                    partTitle = navTitle;
                    console.log(`📖 Using navigation part title (c${filePartNumber} -> part ${navigationPartNumber}): ${partTitle}`);
                } else {
                    // Fallback to original logic if no navigation title found
                    partNumber = filePartNumber;
                    partTitle = `Part ${partNumber}`;
                    console.log(`📁 Found part from filename: ${fileName} -> Part ${partNumber}`);
                }
            }
        }

        // Look for part headers with patterns like "PARTIE 1" and part titles (only if we don't have navigation title)
        if (!partTitle) {
            const partNumberMatch = content.match(/<h1[^>]*class="part_number"[^>]*>.*?(\d+).*?<\/h1>/is);
            const partTitleMatch = content.match(/<h2[^>]*class="part_title"[^>]*>(.*?)<\/h2>/is);

            // Look for part headers in content (language-agnostic)
            const partHeaderMatch = content.match(/<h[1-3][^>]*>(.*?)<\/h[1-3]>/is);

            if (partHeaderMatch) {
                const headerText = partHeaderMatch[1].replace(/<[^>]*>/g, '').trim();
                console.log(`🔍 Found header text: "${headerText}"`);

                // Try to extract any number from the header text (language-agnostic)
                const numberMatch = headerText.match(/(\d+)/);
                if (numberMatch) {
                    const headerPartNumber = parseInt(numberMatch[1]);

                    // Check if we have a navigation title for this part
                    const navTitle = navigationPartTitles.get(headerPartNumber);
                    if (navTitle) {
                        partNumber = headerPartNumber;
                        partTitle = navTitle;
                        console.log(`📖 Using navigation part title from header: ${partTitle}`);
                    } else {
                        // Don't use this number directly - it will be remapped later
                        // Just mark that this is a part header
                        partTitle = headerText;
                        console.log(`🔍 Found part header: "${headerText}"`);
                    }
                }
            }

            if (partNumberMatch) {
                const contentPartNumber = parseInt(partNumberMatch[1]);

                // Check if we have a navigation title for this part
                const navTitle = navigationPartTitles.get(contentPartNumber);
                if (navTitle) {
                    partNumber = contentPartNumber;
                    partTitle = navTitle;
                    console.log(`📖 Using navigation part title from content: ${partTitle}`);
                } else {
                    partNumber = contentPartNumber;
                }
            }

            if (partTitleMatch) {
                if (!partTitle || !navigationPartTitles.has(partNumber || 0)) {
                    partTitle = partTitleMatch[1].replace(/<[^>]*>/g, '').trim();
                }
            }
        }

        // Extract title from various sources, but be smart about it
        const h1Match = content.match(/<h1[^>]*>(.*?)<\/h1>/is);
        const h1Text = h1Match ? h1Match[1].replace(/<[^>]*>/g, '').trim() : null;

        const titleMatches = [
            content.match(/<title[^>]*>([^<]+)<\/title>/i),
            h1Text ? [null, h1Text] : null, // Convert to match format
            content.match(/<h2[^>]*>([^<]+)<\/h2>/i),
            content.match(/<h3[^>]*>([^<]+)<\/h3>/i)
        ].filter(Boolean); // Remove null entries

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

        // Priority 1: If we have a calibre chapter number, use it directly as the title
        if (chapterNumber !== undefined) {
            title = chapterNumber.toString();
        }
        // Priority 2: For structural content (epilogue/prologue), use generic titles
        else if (isEpilogue) {
            title = 'Epilogue';
        } else if (isPrologue) {
            title = 'Prologue';
        }
        // Priority 3: Extract title from content only as last resort
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
        if (lowerText.match(/^(remerciements|acknowledgments?|thanks)/)) patterns.push('acknowledgment');
        if (lowerText.match(/^(bibliographie|bibliography|références|references)/)) patterns.push('bibliography');
        if (lowerText.match(/^(index|table des matières alphabétique)/)) patterns.push('index');

        // Calibre-specific patterns
        if (content.includes('class="chapn"')) patterns.push('calibre-chapter-marker');
        if (chapterNumber !== undefined) patterns.push('calibre-numbered-chapter');

        // Structural epilogue/prologue headers (title-only pages)
        if (lowerContent.includes('<h1') && lowerContent.includes('épilogue')) patterns.push('epilogue-header');
        if (lowerContent.includes('<h1') && lowerContent.includes('prologue')) patterns.push('prologue-header');

        // Part-specific patterns
        if (partNumber !== undefined) patterns.push('part-header');
        if (content.includes('class="part_number"') || content.includes('class="part_title"')) patterns.push('part-marker');

        // Image-heavy content (likely front matter)
        const imageCount = (content.match(/<img[^>]*>/g) || []).length;
        if (imageCount > 0 && wordCount < 20) patterns.push('image-heavy');

        return { title, hasSubstantialText, patterns, wordCount, chapterNumber, partNumber, partTitle };
    };

    // Analyze each spine item
    const spineWithAnalysis = await Promise.all(spine.map(async (spineItem, index) => {
        const entry = entries.find(e => e.fileName.includes(spineItem.href) && !e.isDirectory);
        let analysis = { title: undefined as string | undefined, hasSubstantialText: false, patterns: [] as string[], wordCount: 0, chapterNumber: undefined as number | undefined, partNumber: undefined as number | undefined, partTitle: undefined as string | undefined };

        if (entry) {
            try {
                const content = entry.content.toString('utf-8');
                const contentAnalysis = analyzeContent(content, entry.fileName);
                analysis = {
                    title: contentAnalysis.title,
                    hasSubstantialText: contentAnalysis.hasSubstantialText,
                    patterns: contentAnalysis.patterns,
                    wordCount: contentAnalysis.wordCount,
                    chapterNumber: contentAnalysis.chapterNumber,
                    partNumber: contentAnalysis.partNumber,
                    partTitle: contentAnalysis.partTitle
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
        if (patterns.includes('prologue') || patterns.includes('prologue-header')) {
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
            !patterns.some(p => ['epilogue', 'acknowledgment', 'bibliography', 'index', 'thanks', 'references'].includes(p))) {
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

    // Check for prologue in main content (can be header + content or just content)
    // Look for prologue header pattern first
    let prologueFound = false;
    for (let i = 0; i < Math.min(3, mainContentItems.length); i++) {
        if (mainContentItems[i]?.analysis.patterns.includes('prologue-header')) {
            // Found prologue header, check if next item exists and has substantial content
            if (i + 1 < mainContentItems.length &&
                mainContentItems[i + 1].analysis.hasSubstantialText &&
                mainContentItems[i + 1].analysis.wordCount > 100) {
                classification.prologue = {
                    id: mainContentItems[i + 1].id,
                    href: mainContentItems[i + 1].href,
                    title: 'Prologue' // Override title for prologue content
                };
                // Remove both header and content from main content
                mainContentItems.splice(i, 2);
            } else {
                // Check if this header item itself has substantial content
                if (mainContentItems[i].analysis.hasSubstantialText &&
                    mainContentItems[i].analysis.wordCount > 100) {
                    // The header contains the content too
                    classification.prologue = {
                        id: mainContentItems[i].id,
                        href: mainContentItems[i].href,
                        title: 'Prologue' // Override title for prologue content
                    };
                    mainContentItems.splice(i, 1);
                } else {
                    // Just the header with no substantial content, skip it
                    continue;
                }
            }
            prologueFound = true;
            break;
        }
    }

    // If no prologue header found, check for direct prologue patterns
    if (!prologueFound) {
        const firstMainItem = mainContentItems[0];
        if (firstMainItem?.analysis.patterns.includes('prologue')) {
            classification.prologue = {
                id: firstMainItem.id,
                href: firstMainItem.href,
                title: firstMainItem.analysis.title || 'Prologue'
            };
            mainContentItems.shift(); // Remove from main content
        }
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
                    title: 'Epilogue' // Override title for epilogue content
                };
                // Remove both header and content from main content
                mainContentItems.splice(i, 2);
            } else {
                // Just the header, treat it as epilogue
                classification.epilogue = {
                    id: mainContentItems[i].id,
                    href: mainContentItems[i].href,
                    title: 'Epilogue' // Override title for epilogue header
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

    // Remaining items are chapters - handle calibre numbering, parts, and content pairing
    const chapterItems: Array<{
        id: string;
        href: string;
        title?: string;
        chapterNumber: number;
        partNumber?: number;
        partTitle?: string;
    }> = [];

    // Track part number mapping for multipart books
    let partNumberMapping = new Map<number, number>();

    console.log(`🔍 mainContentItems.length: ${mainContentItems.length}`);
    mainContentItems.forEach((item, index) => {
        console.log(`  ${index}: ${item.href} - patterns: [${item.analysis.patterns.join(', ')}] - wordCount: ${item.analysis.wordCount}`);
    });

    // Detect if this is a multipart book by looking for part headers
    const partHeaders = mainContentItems.filter(item => item.analysis.patterns.includes('part-header'));
    const isMultipartBook = partHeaders.length > 0;

    if (isMultipartBook) {
        console.log(`📚 Detected multipart book with ${partHeaders.length} parts`);

        // Group part headers with their content files
        // In this format, part headers are like c05_part_cut1.xhtml and content is c05_part_cut2.xhtml
        const originalPartGroups = new Map<number, { header: any, contentFiles: any[]; }>();

        for (const partHeader of partHeaders) {
            const originalPartNum = partHeader.analysis.partNumber!;
            if (!originalPartGroups.has(originalPartNum)) {
                originalPartGroups.set(originalPartNum, { header: partHeader, contentFiles: [] });
            }

            // Determine if this is a header file (small word count) or content file (large word count)
            if (partHeader.analysis.wordCount < 100) {
                // This is likely a part header file
                originalPartGroups.get(originalPartNum)!.header = partHeader;
            } else {
                // This is likely a content file for this part
                originalPartGroups.get(originalPartNum)!.contentFiles.push(partHeader);
            }
        }

        // Create a mapping from original part numbers to sequential part numbers (1, 2, 3, ...)
        // Only include parts that have content files
        const partsWithContent = Array.from(originalPartGroups.entries())
            .filter(([partNum, partGroup]) => partGroup.contentFiles.length > 0)
            .map(([partNum]) => partNum)
            .sort((a, b) => a - b);

        partNumberMapping = new Map<number, number>();
        partsWithContent.forEach((originalPartNum, index) => {
            partNumberMapping.set(originalPartNum, index + 1);
        });

        console.log(`📝 Part number mapping: ${Array.from(partNumberMapping.entries()).map(([orig, seq]) => `${orig}→${seq}`).join(', ')}`);

        // Remap part groups to use sequential part numbers
        const partGroups = new Map<number, { header: any, contentFiles: any[]; }>();
        for (const [originalPartNum, partGroup] of originalPartGroups) {
            const sequentialPartNum = partNumberMapping.get(originalPartNum)!;
            partGroups.set(sequentialPartNum, partGroup);
        }

        // Process each part
        for (const [partNumber, partGroup] of partGroups) {
            const partTitle = partGroup.header?.analysis.partTitle || `Part ${partNumber}`;
            console.log(`  📖 Part ${partNumber}: "${partTitle}" (${partGroup.contentFiles.length} content files)`);

            // Process each content file in this part
            for (const item of partGroup.contentFiles) {
                console.log(`      🔍 Processing content file: ${item.href}`);
                console.log(`        - Patterns: ${item.analysis.patterns.join(', ')}`);
                console.log(`        - Has substantial text: ${item.analysis.hasSubstantialText}`);
                console.log(`        - Word count: ${item.analysis.wordCount}`);

                // Skip if doesn't have substantial content
                if (!item.analysis.hasSubstantialText || item.analysis.wordCount < 200) {
                    console.log(`        ⏭️ Skipping content file: ${item.href}`);
                    continue;
                }

                // Look for internal chapter markers
                console.log(`      🔍 Looking for entry with href: ${item.href}`);
                const entry = entries.find(e => e.fileName.includes(item.href) && !e.isDirectory);
                console.log(`      ${entry ? '✅' : '❌'} Entry ${entry ? 'found' : 'not found'}: ${entry?.fileName || 'N/A'}`);

                if (entry) {
                    try {
                        const content = entry.content.toString('utf-8');
                        console.log(`      📄 Content length: ${content.length} characters`);

                        // Extract individual chapters from the content
                        const internalChapters = extractInternalChapters(content, item, partNumber, partTitle);

                        if (internalChapters.length > 0) {
                            // Add all internal chapters
                            for (const internalChapter of internalChapters) {
                                chapterItems.push(internalChapter);
                            }
                        } else {
                            // Fallback: treat the entire file as a single chapter
                            chapterItems.push({
                                id: item.id,
                                href: item.href,
                                title: item.analysis.title || `1`,
                                chapterNumber: 1, // Will be renumbered later
                                partNumber: partNumber,
                                partTitle: partTitle
                            });
                        }
                    } catch (error) {
                        console.warn(`Warning: Could not extract chapters from ${item.href}: ${error}`);
                    }
                }
            }
        }
    } else {
        // Single-part book: use the existing logic
        // Build a map of chapter numbers to items
        const chapterMap = new Map<number, typeof mainContentItems[0]>();
        const unNumberedItems: typeof mainContentItems = [];

        for (const item of mainContentItems) {
            if (item.analysis.chapterNumber !== undefined) {
                chapterMap.set(item.analysis.chapterNumber, item);
            } else {
                unNumberedItems.push(item);
            }
        }

        // Process numbered chapters
        const sortedChapterNumbers = Array.from(chapterMap.keys()).sort((a, b) => a - b);

        for (let i = 0; i < sortedChapterNumbers.length; i++) {
            const chapterNum = sortedChapterNumbers[i];
            const markerItem = chapterMap.get(chapterNum)!;

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
                    // Use the content item but with the chapter number and title from marker
                    chapterItems.push({
                        id: nextContentItem.id,
                        href: nextContentItem.href,
                        title: markerItem.analysis.title || `[${chapterNum}]`, // Use marker title, fallback to [X]
                        chapterNumber: chapterNum
                    });

                    // Remove the content item from unnumbered items to avoid double processing
                    const contentIndex = unNumberedItems.indexOf(nextContentItem);
                    if (contentIndex > -1) {
                        unNumberedItems.splice(contentIndex, 1);
                    }
                } else {
                    // No content found for this chapter marker - check if marker itself has substantial content
                    if (markerItem.analysis.hasSubstantialText && markerItem.analysis.wordCount > 100) {
                        // Only include if the marker itself contains substantial content
                        chapterItems.push({
                            id: markerItem.id,
                            href: markerItem.href,
                            title: markerItem.analysis.title || `[${chapterNum}]`, // Use marker title, fallback to [X]
                            chapterNumber: chapterNum
                        });
                    }
                    // If marker has no substantial content, skip this chapter entirely
                }
            } else {
                // This item has both the marker and substantial content
                chapterItems.push({
                    id: markerItem.id,
                    href: markerItem.href,
                    title: markerItem.analysis.title,
                    chapterNumber: chapterNum
                });
            }
        }

        // Handle any remaining unnumbered items as additional chapters
        let nextChapterNumber = sortedChapterNumbers.length > 0 ? Math.max(...sortedChapterNumbers) + 1 : 1;
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

        // Sort chapters by their chapter number
        chapterItems.sort((a, b) => a.chapterNumber - b.chapterNumber);

        // Note: Part numbers should already be sequential (1, 2, 3...) from the remapped partGroups processing

    }

    // Final filter and processing for both multipart and single-part books
    const filteredChapterItems = await Promise.all(
        chapterItems.map(async (chapterItem) => {
            const entry = entries.find(e => e.fileName.includes(chapterItem.href) && !e.isDirectory);
            if (!entry) return null;

            try {
                const content = entry.content.toString('utf-8');
                const textContent = content
                    .replace(/<[^>]*>/g, ' ') // Remove HTML tags
                    .replace(/\s+/g, ' ') // Normalize whitespace
                    .trim();

                const wordCount = textContent.split(/\s+/).filter(word => word.length > 0).length;

                // Only include chapters with substantial content (more than just a chapter marker)
                if (wordCount > 20) {  // Must have more than just a chapter marker
                    return chapterItem;
                }

                return null;
            } catch (error) {
                console.warn(`Warning: Could not verify content for chapter ${chapterItem.chapterNumber}`);
                return chapterItem; // Keep on error to be safe
            }
        })
    );

    // Filter out null values and renumber chapters sequentially
    const validChapterItems = filteredChapterItems.filter(item => item !== null) as typeof chapterItems;

    // For single-part books, renumber chapters to be sequential starting from 1
    // For multipart books, keep the part-based numbering
    let finalChapterItems: typeof chapterItems;
    if (isMultipartBook) {
        finalChapterItems = validChapterItems; // Keep original numbering within parts
    } else {
        // Renumber chapters to be sequential starting from 1 for single-part books
        finalChapterItems = validChapterItems.map((item, index) => ({
            ...item,
            chapterNumber: index + 1
        }));
    }

    classification.chapters = finalChapterItems;

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
        obsidianNote += `\n## Table of Contents\n`;

        // Add prologue if exists
        if (contentClassification.prologue) {
            const prologueTitle = contentClassification.prologue.title || 'Prologue';
            const prologueFileName = `${sanitizedTitle} - ${sanitizeFileName(prologueTitle)}`;
            obsidianNote += `\n**Prologue**: [[${prologueFileName}]]\n`;
        }

        // Check if this is a multipart book
        const isMultipart = contentClassification.chapters.some(chapter => chapter.partNumber !== undefined);

        if (isMultipart) {
            // Group chapters by part for multipart books
            const partGroups = new Map<number, typeof contentClassification.chapters>();
            contentClassification.chapters.forEach(chapter => {
                const partNum = chapter.partNumber || 1;
                if (!partGroups.has(partNum)) {
                    partGroups.set(partNum, []);
                }
                partGroups.get(partNum)!.push(chapter);
            });

            // Generate ToC by parts
            for (const [partNumber, chapters] of partGroups) {
                const rawPartTitle = chapters[0]?.partTitle;
                let partTitle: string;

                // Check if we have a meaningful part title (not just a number or generic text)
                if (rawPartTitle &&
                    rawPartTitle !== `Part ${partNumber}` &&
                    !/^\d+\.?$/.test(rawPartTitle.trim()) && // Not just a number like "1." or "5"
                    rawPartTitle.trim().length > 2) { // Has substantial content
                    partTitle = `Part ${partNumber} - ${rawPartTitle}`;
                } else {
                    partTitle = `Part ${partNumber}`;
                }

                obsidianNote += `\n### ${partTitle}\n`;

                chapters.forEach(chapter => {
                    const chapterNumber = chapter.chapterNumber;
                    const chapterFileName = `${sanitizedTitle} - Part ${partNumber} - Chapter ${chapterNumber}`;
                    obsidianNote += `${chapterNumber}. [[${chapterFileName}]]\n`;
                });
            }
        } else {
            // Single-part book - use simple numbering
            obsidianNote += `\n`;
            contentClassification.chapters.forEach((chapter, index) => {
                const chapterNumber = chapter.chapterNumber || index + 1;
                const chapterFileName = `${sanitizedTitle} - Chapter ${chapterNumber}`;
                obsidianNote += `${chapterNumber}. [[${chapterFileName}]]\n`;
            });
        }

        // Add epilogue if exists
        if (contentClassification.epilogue) {
            const epilogueTitle = contentClassification.epilogue.title || 'Epilogue';
            const epilogueFileName = `${sanitizedTitle} - ${sanitizeFileName(epilogueTitle)}`;
            obsidianNote += `\n**Epilogue**: [[${epilogueFileName}]]\n`;
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
        // Always use the sequential chapter number as title to ensure bijection
        const chapterTitle = chapter.chapterNumber.toString();

        // Check if this chapter has specific content (from internal chapter extraction)
        console.log(`🔍 Chapter ${chapter.chapterNumber}: content property exists: ${'content' in chapter}, content type: ${typeof chapter.content}, content length: ${chapter.content ? chapter.content.length : 'N/A'}`);

        if ('content' in chapter && typeof chapter.content === 'string' && chapter.content) {
            console.log(`✅ Using processChapterWithContent for chapter ${chapter.chapterNumber}`);
            // Use the extracted chapter content directly
            await processChapterWithContent(
                chapter.content,
                chapterTitle,
                bookDir,
                'chapter',
                chapter.chapterNumber,
                bookTitle,
                chapter.partNumber,
                chapter.partTitle
            );
        } else {
            console.log(`❌ Using processContentFile for chapter ${chapter.chapterNumber}`);
            // Use the original file processing for chapters without specific content
            await processContentFile(
                entries,
                chapter.href,
                chapterTitle,
                bookDir,
                'chapter',
                chapter.chapterNumber,
                bookTitle,
                chapter.partNumber,
                chapter.partTitle
            );
        }
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
 * Process a chapter with specific content (for internally extracted chapters)
 */
async function processChapterWithContent(
    content: string,
    title: string,
    bookDir: string,
    type: 'prologue' | 'chapter' | 'epilogue',
    chapterNumber?: number,
    bookTitle?: string,
    partNumber?: number,
    partTitle?: string
): Promise<void> {
    try {
        const markdownContent = convertCalibreToMarkdown(content, title, type, chapterNumber, bookTitle, partNumber, partTitle);

        // Generate proper filename based on type
        let noteFileName: string;
        const sanitizedBookTitle = sanitizeFileName(bookTitle || 'Book');

        if (type === 'prologue') {
            noteFileName = `${sanitizedBookTitle} - Prologue.md`;
        } else if (type === 'epilogue') {
            noteFileName = `${sanitizedBookTitle} - Epilogue.md`;
        } else if (type === 'chapter' && chapterNumber) {
            if (partNumber && partTitle) {
                // For multipart books, include part information in filename with "-" separator
                noteFileName = `${sanitizedBookTitle} - Part ${partNumber} - Chapter ${chapterNumber}.md`;
            } else {
                noteFileName = `${sanitizedBookTitle} - Chapter ${chapterNumber}.md`;
            }
        } else {
            // Fallback
            const sanitizedTitle = sanitizeFileName(title);
            noteFileName = `${sanitizedTitle}.md`;
        }

        const notePath = path.join(bookDir, noteFileName);

        fs.writeFileSync(notePath, markdownContent);
        console.log(`📄 Generated ${type}: ${noteFileName}`);
    } catch (error) {
        console.error(`❌ Error processing chapter content:`, error);
    }
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
    bookTitle?: string,
    partNumber?: number,
    partTitle?: string
): Promise<void> {
    // Find the content entry
    const entry = entries.find(e => e.fileName.includes(href) && !e.isDirectory);
    if (!entry) {
        console.warn(`⚠️ Content file not found: ${href}`);
        return;
    }

    try {
        const content = entry.content.toString('utf-8');
        const markdownContent = convertCalibreToMarkdown(content, title, type, chapterNumber, bookTitle, partNumber, partTitle);

        // Generate proper filename based on type
        let noteFileName: string;
        const sanitizedBookTitle = sanitizeFileName(bookTitle || 'Book');

        if (type === 'prologue') {
            noteFileName = `${sanitizedBookTitle} - Prologue.md`;
        } else if (type === 'epilogue') {
            noteFileName = `${sanitizedBookTitle} - Epilogue.md`;
        } else if (type === 'chapter' && chapterNumber) {
            if (partNumber && partTitle) {
                // For multipart books, include part information in filename with "-" separator
                noteFileName = `${sanitizedBookTitle} - Part ${partNumber} - Chapter ${chapterNumber}.md`;
            } else {
                noteFileName = `${sanitizedBookTitle} - Chapter ${chapterNumber}.md`;
            }
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
    bookTitle?: string,
    partNumber?: number,
    partTitle?: string
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
    // Add part information for multipart books
    if (partNumber) {
        markdown += `part: ${partNumber}\n`;
    }
    if (partTitle) {
        markdown += `partTitle: "${partTitle}"\n`;
    }
    markdown += `source: epub\n`;
    markdown += `---\n\n`;

    // Add title header - include part title for context in multipart books
    if (type === 'chapter' && partTitle) {
        markdown += `# ${title}\n\n`;
        markdown += `*${partTitle}*\n\n`;
    } else {
        markdown += `# ${title}\n\n`;
    }

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
        // Handle chapter number and title structure specially
        .replace(/<h1[^>]*class="chapn"[^>]*>(.*?)<\/h1>/gs, '') // Remove chapter number headers (redundant with title)
        .replace(/<h1[^>]*class="chap_n"[^>]*>(.*?)<\/h1>/gs, '') // Remove chapter number headers (Pandemia style, redundant with title)
        .replace(/<h1[^>]*class="chaptit"[^>]*>(.*?)<\/h1>/gs, (match, content) => {
            // Extract the chapter subtitle (like date)
            const cleanContent = content.replace(/<[^>]*>/g, '').trim();
            return `**${cleanContent}**\n\n`; // Make chapter subtitle bold
        })
        .replace(/<h2[^>]*class="int_niv"[^>]*>(.*?)<\/h2>/gs, (match, content) => {
            // Extract the chapter subtitle (Pandemia style - like date)
            const cleanContent = content.replace(/<[^>]*>/g, '').trim();
            return `**${cleanContent}**\n\n`; // Make chapter subtitle bold
        })
        .replace(/<h1[^>]*class="prestit"[^>]*>(.*?)<\/h1>/gs, (match, content) => {
            // Extract the prologue subtitle (like date)
            const cleanContent = content.replace(/<[^>]*>/g, '').trim();
            return `**${cleanContent}**\n\n`; // Make prologue subtitle bold
        })
        .replace(/<h1[^>]*class="pre_tit"[^>]*>(.*?)<\/h1>/gs, '') // Remove prologue title headers (Pandemia style, redundant with title)
        // Convert footnote sections to Obsidian format FIRST (before div removal)
        .replace(/<hr class="border_note"\/>/g, '') // Remove footnote separator (Pandemia style)
        .replace(/<hr class="bordernote"\/>/g, '') // Remove footnote separator (Dossier 64 style)
        // Handle Pandemia footnote format
        .replace(/<div class="ntb" id="ntb-(\d+)"><p class="txt_justif"><a[^>]*>(\d+)<\/a>\.\s*(.*?)<\/p><\/div>/gs, '[^$2]: $3\n\n')
        // Handle Dossier 64 footnote format
        .replace(/<div class="ntb" id="NBP(\d+)"><div class="numero"><a[^>]*>(\d+)<\/a>\.\s*<\/div><div class="textenote"><p[^>]*>(.*?)<\/p><\/div><\/div>/gs, '[^$2]: $3\n\n')
        .replace(/<div[^>]*class="dev"[^>]*>/g, '') // Remove dev containers
        .replace(/<\/div>/g, ''); // Remove closing divs

    // Convert calibre text classes to markdown
    textContent = textContent
        // Convert paragraph with first letter styling
        .replace(/<p class="txt_courant_ssalinea"><span class="let">(.*?)<\/span>(.*?)<\/p>/gs, '**$1**$2\n\n')
        // Convert regular paragraphs (various patterns) - use non-greedy matching with dot-all
        .replace(/<p class="txt_courant_[^"]*">(.*?)<\/p>/gs, '$1\n\n')
        .replace(/<p class="txtcourant[^"]*">(.*?)<\/p>/gs, '$1\n\n')
        .replace(/<p class="txtcourantjustif">(.*?)<\/p>/gs, '$1\n\n')
        // Convert justified paragraphs
        .replace(/<p class="txt_courant_justif">(.*?)<\/p>/gs, '$1\n\n')
        // Convert generic paragraphs - make this more greedy to catch all paragraphs
        .replace(/<p[^>]*>(.*?)<\/p>/gs, '$1\n\n')
        // Convert italic text
        .replace(/<i class="calibre2">(.*?)<\/i>/gs, '*$1*')
        // Convert footnote links to Obsidian format
        // Pandemia format: <a class="apnb" href="#ntb-1">1</a>
        .replace(/<a class="apnb"[^>]*href="[^#]*#ntb-(\d+)"[^>]*>(\d+)<\/a>/g, '[^$2]')
        // Dossier 64 format: <a class="apnb" id="ap_NBP1-1" href="part0005.html#NBP1">1</a>
        .replace(/<a class="apnb"[^>]*href="[^#]*#NBP(\d+)"[^>]*>(\d+)<\/a>/g, '[^$2]')
        // Remove page anchors (no longer needed per requirements)
        .replace(/<a id="page_(\d+)" class="calibre[^"]*"><\/a>/g, '')
        .replace(/<a id="page_(\d+)" class="calibre\d+"><\/a>/g, '');

    // Post-process to clean up text
    textContent = textContent;

    // Handle special content blocks like letters
    textContent = textContent
        .replace(/<div class="lettre">/g, '\n> **Letter/Email:**\n> ')
        .replace(/<\/div>/g, '\n\n');

    // Clean up remaining HTML tags
    textContent = textContent
        .replace(/<[^>]*>/g, '') // Remove any remaining HTML tags
        .replace(/&[^;]+;/g, '') // Remove HTML entities (basic cleanup)
        .replace(/\n\s*\n\s*\n/g, '\n\n') // Normalize multiple newlines
        .replace(/^[ \t]+/gm, '') // Remove leading whitespace/indentation from lines with content (but preserve blank lines)
        // Fix date formatting: "32Novembre 2010La" -> "32\n\nNovembre 2010\n\nLa" 
        // But be more specific to avoid interfering with footnotes
        .replace(/(\d{1,2})([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ][a-zàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]+\s+\d{4})([A-ZÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ])/g, '$1\n\n$2\n\n$3')
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