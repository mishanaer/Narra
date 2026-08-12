#!/usr/bin/env node
/**
 * fetch-en-catalog.mjs — P22: build the English preload library for Narra.
 *
 * - 150 curated classics (product-owner core + editorial picks), tier "curated"
 * - filled up to 1000 with the most-downloaded English fiction on Project
 *   Gutenberg (Gutendex sort=popular), tier "popular"
 * - resolution via Gutendex API, sequential polite downloads (300 ms pause),
 *   full EPUB validation (zip integrity, mimetype, OPF, spine, text volume,
 *   title fuzzy match, language), manifest.json + README.md.
 *
 * No external dependencies. Node >= 18 (global fetch). Resumable: state.json
 * in the output dir tracks completed books; re-running skips them.
 *
 * Env overrides (for smoke tests):
 *   NARRA_OUT_DIR, NARRA_TOTAL, NARRA_CURATED_LIMIT, NARRA_MAX_PAGES
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const OUT_DIR = process.env.NARRA_OUT_DIR || '/Users/aleksandr/Documents/ReadAny-catalog-en';
const TOTAL_TARGET = +(process.env.NARRA_TOTAL || 1000);
const CURATED_LIMIT = +(process.env.NARRA_CURATED_LIMIT || 150);
const MAX_POPULAR_PAGES = +(process.env.NARRA_MAX_PAGES || 160);
const PAUSE_MS = 300;
const UA = 'NarraCatalogFetcher/1.0 (Narra reading app catalog build; contact: andreikormachyov@gmail.com)';
const API = 'https://gutendex.com/books';
const PROSE_MIN_TEXT = 80 * 1024;
const VERSE_MIN_TEXT = 40 * 1024; // plays / poetry
const POPULAR_AUTHOR_CAP = 15;
const CURATED_AUTHOR_CAP = 6;

// ---------------------------------------------------------------------------
// Curated catalog: 150 titles. Core list from the product owner first (1-24),
// then editorial picks. Fields: t=title (expected), a=author search key,
// an=author display, k=kind (prose|play|poetry), id=Gutenberg id hint.
// ---------------------------------------------------------------------------
const CURATED = [
  // --- product-owner core (deduped, typos fixed) ---
  { t: 'Pride and Prejudice', a: 'Austen', an: 'Jane Austen', id: 1342 },
  { t: 'The Picture of Dorian Gray', a: 'Wilde', an: 'Oscar Wilde', id: 174 },
  { t: 'Robinson Crusoe', a: 'Defoe', an: 'Daniel Defoe', id: 521 },
  { t: 'Jane Eyre', a: 'Bronte', an: 'Charlotte Brontë', id: 1260 },
  { t: 'The Woman in White', a: 'Collins', an: 'Wilkie Collins', id: 583 },
  { t: 'Three Men in a Boat', a: 'Jerome', an: 'Jerome K. Jerome', id: 308 },
  { t: 'A Tale of Two Cities', a: 'Dickens', an: 'Charles Dickens', id: 98 },
  { t: 'The Sea-Wolf', a: 'London', an: 'Jack London', id: 1074 },
  { t: 'The Human Drift', a: 'London', an: 'Jack London' },
  { t: 'The Odyssey', a: 'Homer', an: 'Homer', k: 'poetry', id: 1727 },
  { t: 'The Divine Comedy', a: 'Dante', an: 'Dante Alighieri', k: 'poetry', id: 8800 },
  { t: 'The Iliad', a: 'Homer', an: 'Homer', k: 'poetry', id: 6130 },
  { t: 'The Adventures of Tom Sawyer', a: 'Twain', an: 'Mark Twain', id: 74 },
  { t: 'The Forsyte Saga', a: 'Galsworthy', an: 'John Galsworthy', id: 4397 },
  { t: 'An Ideal Husband', a: 'Wilde', an: 'Oscar Wilde', k: 'play', id: 885 },
  { t: "Alice's Adventures in Wonderland", a: 'Carroll', an: 'Lewis Carroll', id: 11 },
  { t: 'The Return of Sherlock Holmes', a: 'Doyle', an: 'Arthur Conan Doyle', id: 108 },
  { t: 'A Woman of No Importance', a: 'Wilde', an: 'Oscar Wilde', k: 'play', id: 854 },
  { t: 'Oliver Twist', a: 'Dickens', an: 'Charles Dickens', id: 730 },
  { t: 'Romeo and Juliet', a: 'Shakespeare', an: 'William Shakespeare', k: 'play', id: 1513 },
  { t: 'The Adventures of Sherlock Holmes', a: 'Doyle', an: 'Arthur Conan Doyle', id: 1661 },
  { t: 'Little Women', a: 'Alcott', an: 'Louisa May Alcott' },
  { t: 'Dracula', a: 'Stoker', an: 'Bram Stoker', id: 345 },
  { t: 'The Great Gatsby', a: 'Fitzgerald', an: 'F. Scott Fitzgerald', id: 64317 },
  // --- editorial picks ---
  { t: 'Sense and Sensibility', a: 'Austen', an: 'Jane Austen', id: 161 },
  { t: 'Emma', a: 'Austen', an: 'Jane Austen', id: 158 },
  { t: 'Persuasion', a: 'Austen', an: 'Jane Austen', id: 105 },
  { t: 'Mansfield Park', a: 'Austen', an: 'Jane Austen', id: 141 },
  { t: 'Northanger Abbey', a: 'Austen', an: 'Jane Austen', id: 121 },
  { t: 'Great Expectations', a: 'Dickens', an: 'Charles Dickens', id: 1400 },
  { t: 'David Copperfield', a: 'Dickens', an: 'Charles Dickens', id: 766 },
  { t: 'A Christmas Carol', a: 'Dickens', an: 'Charles Dickens', id: 46 },
  { t: 'Bleak House', a: 'Dickens', an: 'Charles Dickens', id: 1023 },
  { t: 'The Importance of Being Earnest', a: 'Wilde', an: 'Oscar Wilde', k: 'play', id: 844 },
  { t: "Lady Windermere's Fan", a: 'Wilde', an: 'Oscar Wilde', k: 'play', id: 790 },
  { t: 'The Canterville Ghost', a: 'Wilde', an: 'Oscar Wilde', id: 14522 },
  { t: 'The Hound of the Baskervilles', a: 'Doyle', an: 'Arthur Conan Doyle', id: 2852 },
  { t: 'A Study in Scarlet', a: 'Doyle', an: 'Arthur Conan Doyle', id: 244 },
  { t: 'The Sign of the Four', a: 'Doyle', an: 'Arthur Conan Doyle', id: 2097 },
  { t: 'The Memoirs of Sherlock Holmes', a: 'Doyle', an: 'Arthur Conan Doyle', id: 834 },
  { t: 'Wuthering Heights', a: 'Bronte', an: 'Emily Brontë', id: 768 },
  { t: 'Villette', a: 'Bronte', an: 'Charlotte Brontë', id: 9182 },
  { t: 'The Tenant of Wildfell Hall', a: 'Bronte', an: 'Anne Brontë', id: 969 },
  { t: 'Adventures of Huckleberry Finn', a: 'Twain', an: 'Mark Twain', id: 76 },
  { t: "A Connecticut Yankee in King Arthur's Court", a: 'Twain', an: 'Mark Twain', id: 86 },
  { t: 'Twenty Thousand Leagues Under the Sea', a: 'Verne', an: 'Jules Verne', id: 164 },
  { t: 'Around the World in Eighty Days', a: 'Verne', an: 'Jules Verne', id: 103 },
  { t: 'Journey to the Centre of the Earth', a: 'Verne', an: 'Jules Verne', id: 18857 },
  { t: 'The Mysterious Island', a: 'Verne', an: 'Jules Verne', id: 1268 },
  { t: 'The Time Machine', a: 'Wells', an: 'H. G. Wells', id: 35 },
  { t: 'The War of the Worlds', a: 'Wells', an: 'H. G. Wells', id: 36 },
  { t: 'The Invisible Man', a: 'Wells', an: 'H. G. Wells', id: 5230 },
  { t: 'Treasure Island', a: 'Stevenson', an: 'Robert Louis Stevenson', id: 120 },
  { t: 'The Strange Case of Dr. Jekyll and Mr. Hyde', a: 'Stevenson', an: 'Robert Louis Stevenson', id: 43 },
  { t: 'Kidnapped', a: 'Stevenson', an: 'Robert Louis Stevenson', id: 421 },
  { t: 'Moby Dick', a: 'Melville', an: 'Herman Melville', id: 2701 },
  { t: 'The Narrative of Arthur Gordon Pym of Nantucket', a: 'Poe', an: 'Edgar Allan Poe' },
  { t: 'The Scarlet Letter', a: 'Hawthorne', an: 'Nathaniel Hawthorne', id: 25344 },
  { t: 'The House of the Seven Gables', a: 'Hawthorne', an: 'Nathaniel Hawthorne', id: 77 },
  { t: "Tess of the d'Urbervilles", a: 'Hardy', an: 'Thomas Hardy', id: 110 },
  { t: 'Far from the Madding Crowd', a: 'Hardy', an: 'Thomas Hardy' },
  { t: 'Middlemarch', a: 'Eliot', an: 'George Eliot', id: 145 },
  { t: 'Silas Marner', a: 'Eliot', an: 'George Eliot', id: 550 },
  { t: 'North and South', a: 'Gaskell', an: 'Elizabeth Gaskell', id: 4276 },
  { t: 'Cranford', a: 'Gaskell', an: 'Elizabeth Gaskell', id: 394 },
  { t: 'The Jungle Book', a: 'Kipling', an: 'Rudyard Kipling', id: 236 },
  { t: 'Kim', a: 'Kipling', an: 'Rudyard Kipling', id: 2226 },
  { t: 'Captains Courageous', a: 'Kipling', an: 'Rudyard Kipling', id: 2186 },
  { t: 'The Call of the Wild', a: 'London', an: 'Jack London', id: 215 },
  { t: 'White Fang', a: 'London', an: 'Jack London', id: 910 },
  { t: 'Martin Eden', a: 'London', an: 'Jack London', id: 1056 },
  { t: 'Frankenstein', a: 'Shelley', an: 'Mary Wollstonecraft Shelley', id: 84 },
  { t: 'Through the Looking-Glass', a: 'Carroll', an: 'Lewis Carroll', id: 12 },
  { t: 'Moll Flanders', a: 'Defoe', an: 'Daniel Defoe', id: 370 },
  { t: "Gulliver's Travels", a: 'Swift', an: 'Jonathan Swift', id: 829 },
  { t: 'The Count of Monte Cristo', a: 'Dumas', an: 'Alexandre Dumas', id: 1184 },
  { t: 'The Three Musketeers', a: 'Dumas', an: 'Alexandre Dumas', id: 1257 },
  { t: 'Twenty Years After', a: 'Dumas', an: 'Alexandre Dumas', id: 1259 },
  { t: 'Les Misérables', a: 'Hugo', an: 'Victor Hugo', id: 135 },
  { t: 'Notre-Dame de Paris', a: 'Hugo', an: 'Victor Hugo', id: 2610 },
  { t: 'Madame Bovary', a: 'Flaubert', an: 'Gustave Flaubert', id: 2413 },
  { t: 'War and Peace', a: 'Tolstoy', an: 'Leo Tolstoy', id: 2600 },
  { t: 'Anna Karenina', a: 'Tolstoy', an: 'Leo Tolstoy', id: 1399 },
  { t: 'Crime and Punishment', a: 'Dostoyevsky', an: 'Fyodor Dostoyevsky', id: 2554 },
  { t: 'The Brothers Karamazov', a: 'Dostoyevsky', an: 'Fyodor Dostoyevsky', id: 28054 },
  { t: 'The Idiot', a: 'Dostoyevsky', an: 'Fyodor Dostoyevsky', id: 2638 },
  { t: 'The Lady with the Dog and Other Stories', a: 'Chekhov', an: 'Anton Chekhov', id: 13415 },
  { t: 'Fathers and Children', a: 'Turgenev', an: 'Ivan Turgenev', id: 30723 },
  { t: 'Dead Souls', a: 'Gogol', an: 'Nikolai Gogol', id: 1081 },
  { t: 'The Aeneid', a: 'Virgil', an: 'Virgil', k: 'poetry', id: 228 },
  { t: 'Hamlet', a: 'Shakespeare', an: 'William Shakespeare', k: 'play', id: 1524 },
  { t: 'Macbeth', a: 'Shakespeare', an: 'William Shakespeare', k: 'play', id: 1533 },
  { t: 'Othello', a: 'Shakespeare', an: 'William Shakespeare', k: 'play', id: 1531 },
  { t: 'King Lear', a: 'Shakespeare', an: 'William Shakespeare', k: 'play', id: 1532 },
  { t: "A Midsummer Night's Dream", a: 'Shakespeare', an: 'William Shakespeare', k: 'play' },
  { t: 'Tartuffe', a: 'Moliere', an: 'Molière', k: 'play', id: 2027 },
  { t: 'Don Quixote', a: 'Cervantes', an: 'Miguel de Cervantes', id: 996 },
  { t: 'Faust', a: 'Goethe', an: 'Johann Wolfgang von Goethe', k: 'play', id: 14591 },
  { t: 'The Moonstone', a: 'Collins', an: 'Wilkie Collins', id: 155 },
  { t: 'Carmilla', a: 'Le Fanu', an: 'Joseph Sheridan Le Fanu', id: 10007 },
  { t: 'The Castle of Otranto', a: 'Walpole', an: 'Horace Walpole', id: 696 },
  { t: 'The Monk', a: 'Lewis', an: 'Matthew Gregory Lewis', id: 601 },
  { t: 'The Turn of the Screw', a: 'James', an: 'Henry James', id: 209 },
  { t: 'Washington Square', a: 'James', an: 'Henry James', id: 2870 },
  { t: "King Solomon's Mines", a: 'Haggard', an: 'H. Rider Haggard', id: 2166 },
  { t: 'The Prisoner of Zenda', a: 'Hope', an: 'Anthony Hope', id: 95 },
  { t: 'Scaramouche', a: 'Sabatini', an: 'Rafael Sabatini', id: 1947 },
  { t: 'The Scarlet Pimpernel', a: 'Orczy', an: 'Baroness Orczy', id: 60 },
  { t: 'The Thirty-Nine Steps', a: 'Buchan', an: 'John Buchan', id: 558 },
  { t: 'Ivanhoe', a: 'Scott', an: 'Walter Scott', id: 82 },
  { t: 'The Mysterious Affair at Styles', a: 'Christie', an: 'Agatha Christie', id: 863 },
  { t: 'Peter Pan', a: 'Barrie', an: 'J. M. Barrie', id: 16 },
  { t: 'The Wind in the Willows', a: 'Grahame', an: 'Kenneth Grahame', id: 289 },
  { t: 'The Wonderful Wizard of Oz', a: 'Baum', an: 'L. Frank Baum', id: 55 },
  { t: 'Heidi', a: 'Spyri', an: 'Johanna Spyri', id: 1448 },
  { t: 'Black Beauty', a: 'Sewell', an: 'Anna Sewell', id: 271 },
  { t: 'The Secret Garden', a: 'Burnett', an: 'Frances Hodgson Burnett', id: 113 },
  { t: 'A Little Princess', a: 'Burnett', an: 'Frances Hodgson Burnett', id: 146 },
  { t: 'Anne of Green Gables', a: 'Montgomery', an: 'L. M. Montgomery', id: 45 },
  { t: 'The Adventures of Pinocchio', a: 'Collodi', an: 'Carlo Collodi', id: 500 },
  { t: "Grimms' Fairy Tales", a: 'Grimm', an: 'Jacob and Wilhelm Grimm', id: 2591 },
  { t: "Andersen's Fairy Tales", a: 'Andersen', an: 'Hans Christian Andersen', id: 1597 },
  { t: "Uncle Tom's Cabin", a: 'Stowe', an: 'Harriet Beecher Stowe', id: 203 },
  { t: 'The Red Badge of Courage', a: 'Crane', an: 'Stephen Crane', id: 73 },
  { t: 'The Age of Innocence', a: 'Wharton', an: 'Edith Wharton', id: 541 },
  { t: 'Tarzan of the Apes', a: 'Burroughs', an: 'Edgar Rice Burroughs', id: 78 },
  { t: 'The Jungle', a: 'Sinclair', an: 'Upton Sinclair', id: 140 },
  { t: 'Dubliners', a: 'Joyce', an: 'James Joyce', id: 2814 },
  { t: 'A Portrait of the Artist as a Young Man', a: 'Joyce', an: 'James Joyce', id: 4217 },
  { t: 'Ulysses', a: 'Joyce', an: 'James Joyce', id: 4300 },
  { t: 'Mrs. Dalloway', a: 'Woolf', an: 'Virginia Woolf' },
  { t: 'The Voyage Out', a: 'Woolf', an: 'Virginia Woolf', id: 144 },
  { t: 'This Side of Paradise', a: 'Fitzgerald', an: 'F. Scott Fitzgerald', id: 805 },
  { t: 'Heart of Darkness', a: 'Conrad', an: 'Joseph Conrad', id: 219 },
  { t: 'Lord Jim', a: 'Conrad', an: 'Joseph Conrad', id: 5658 },
  { t: 'Vanity Fair', a: 'Thackeray', an: 'William Makepeace Thackeray', id: 599 },
  { t: 'The Man Who Was Thursday', a: 'Chesterton', an: 'G. K. Chesterton', id: 1695 },
  { t: 'The Innocence of Father Brown', a: 'Chesterton', an: 'G. K. Chesterton', id: 204 },
  { t: 'Of Human Bondage', a: 'Maugham', an: 'W. Somerset Maugham', id: 351 },
  { t: 'A Room with a View', a: 'Forster', an: 'E. M. Forster', id: 2641 },
  { t: 'Sons and Lovers', a: 'Lawrence', an: 'D. H. Lawrence' },
  { t: 'Main Street', a: 'Lewis', an: 'Sinclair Lewis', id: 543 },
  { t: 'Metamorphosis', a: 'Kafka', an: 'Franz Kafka', id: 5200 },
  { t: 'Siddhartha', a: 'Hesse', an: 'Hermann Hesse', id: 2500 },
  { t: 'Candide', a: 'Voltaire', an: 'Voltaire', id: 19942 },
  { t: 'The Phantom of the Opera', a: 'Leroux', an: 'Gaston Leroux', id: 175 },
  { t: 'Father Goriot', a: 'Balzac', an: 'Honoré de Balzac', id: 1237 },
  { t: 'Paradise Lost', a: 'Milton', an: 'John Milton', k: 'poetry', id: 20 },
  { t: 'Leaves of Grass', a: 'Whitman', an: 'Walt Whitman', k: 'poetry', id: 1322 },
  { t: 'Beowulf', a: '', an: 'Unknown (Anglo-Saxon epic)', k: 'poetry', id: 16328 },
];

// Ordered substitutes used when a curated title cannot be resolved/validated.
const ALTERNATES = [
  { t: 'Notes from the Underground', a: 'Dostoyevsky', an: 'Fyodor Dostoyevsky', id: 600 },
  { t: 'The Island of Doctor Moreau', a: 'Wells', an: 'H. G. Wells', id: 159 },
  { t: 'The Prince and the Pauper', a: 'Twain', an: 'Mark Twain', id: 1837 },
  { t: 'From the Earth to the Moon', a: 'Verne', an: 'Jules Verne', id: 83 },
  { t: 'The Man in the Iron Mask', a: 'Dumas', an: 'Alexandre Dumas', id: 2759 },
  { t: 'Jude the Obscure', a: 'Hardy', an: 'Thomas Hardy', id: 153 },
  { t: 'The Mill on the Floss', a: 'Eliot', an: 'George Eliot', id: 6688 },
  { t: 'Wives and Daughters', a: 'Gaskell', an: 'Elizabeth Gaskell', id: 4274 },
  { t: 'She', a: 'Haggard', an: 'H. Rider Haggard', id: 3155 },
  { t: 'Captain Blood', a: 'Sabatini', an: 'Rafael Sabatini', id: 1965 },
  { t: 'A Princess of Mars', a: 'Burroughs', an: 'Edgar Rice Burroughs', id: 62 },
  { t: 'Ethan Frome', a: 'Wharton', an: 'Edith Wharton', id: 4517 },
  { t: 'The Awakening', a: 'Chopin', an: 'Kate Chopin', id: 160 },
  { t: 'Howards End', a: 'Forster', an: 'E. M. Forster', id: 2946 },
  { t: 'Night and Day', a: 'Woolf', an: 'Virginia Woolf', id: 1245 },
  { t: 'The Secret Agent', a: 'Conrad', an: 'Joseph Conrad', id: 974 },
  { t: 'Daisy Miller', a: 'James', an: 'Henry James', id: 2044 },
  { t: 'Uncle Silas', a: 'Le Fanu', an: 'Joseph Sheridan Le Fanu', id: 14851 },
  { t: 'The Mysteries of Udolpho', a: 'Radcliffe', an: 'Ann Radcliffe', id: 3268 },
  { t: 'The Black Arrow', a: 'Stevenson', an: 'Robert Louis Stevenson', id: 848 },
  { t: 'Barchester Towers', a: 'Trollope', an: 'Anthony Trollope', id: 3409 },
  { t: 'Pollyanna', a: 'Porter', an: 'Eleanor H. Porter', id: 1450 },
  { t: 'The Enchanted April', a: 'Arnim', an: 'Elizabeth von Arnim', id: 16389 },
  { t: 'Babbitt', a: 'Lewis', an: 'Sinclair Lewis', id: 1156 },
  { t: 'The Four Million', a: 'Henry', an: 'O. Henry', id: 2776 },
  { t: 'Idylls of the King', a: 'Tennyson', an: 'Alfred Tennyson', k: 'poetry', id: 610 },
  { t: 'The Riddle of the Sands', a: 'Childers', an: 'Erskine Childers', id: 2360 },
  { t: 'Riders of the Purple Sage', a: 'Grey', an: 'Zane Grey', id: 1300 },
  { t: 'The Way of All Flesh', a: 'Butler', an: 'Samuel Butler', id: 2084 },
  { t: 'The Beautiful and Damned', a: 'Fitzgerald', an: 'F. Scott Fitzgerald', id: 9830 },
];

// ---------------------------------------------------------------------------
// Non-fiction shelves: canonical seeds per category (resolved via Gutendex
// search like curated titles), then topped up to NONFIC_MIN via topic queries.
// ---------------------------------------------------------------------------
const NONFIC_MIN = +(process.env.NARRA_NONFIC_MIN || 25);

const NONFIC_SEEDS = {
  psychology: [
    { t: 'Dream Psychology: Psychoanalysis for Beginners', a: 'Freud', an: 'Sigmund Freud', id: 15489 },
    { t: 'A General Introduction to Psychoanalysis', a: 'Freud', an: 'Sigmund Freud', id: 38219 },
    { t: 'Three Contributions to the Theory of Sex', a: 'Freud', an: 'Sigmund Freud' },
    { t: 'Totem and Taboo', a: 'Freud', an: 'Sigmund Freud' },
    { t: 'The Interpretation of Dreams', a: 'Freud', an: 'Sigmund Freud' },
    { t: 'The Crowd: A Study of the Popular Mind', a: 'Le Bon', an: 'Gustave Le Bon', id: 445 },
    { t: 'The Psychology of Revolution', a: 'Le Bon', an: 'Gustave Le Bon' },
    { t: 'Psychology of the Unconscious', a: 'Jung', an: 'Carl Gustav Jung' },
    { t: 'Talks to Teachers on Psychology', a: 'James', an: 'William James' },
    { t: 'The Principles of Psychology', a: 'James', an: 'William James' },
    { t: 'The Varieties of Religious Experience', a: 'James', an: 'William James', id: 621 },
    { t: 'The Behavior of Crowds', a: 'Martin', an: 'Everett Dean Martin' },
    { t: 'Instincts of the Herd in Peace and War', a: 'Trotter', an: 'Wilfred Trotter' },
  ],
  philosophy: [
    { t: 'The Republic', a: 'Plato', an: 'Plato', id: 1497 },
    { t: 'Symposium', a: 'Plato', an: 'Plato', id: 1600 },
    { t: 'Apology', a: 'Plato', an: 'Plato' },
    { t: 'The Ethics of Aristotle', a: 'Aristotle', an: 'Aristotle', id: 8438 },
    { t: 'Politics: A Treatise on Government', a: 'Aristotle', an: 'Aristotle', id: 6762 },
    { t: 'The Poetics of Aristotle', a: 'Aristotle', an: 'Aristotle', id: 1974 },
    { t: 'Meditations', a: 'Aurelius', an: 'Marcus Aurelius', id: 2680 },
    { t: 'The Enchiridion', a: 'Epictetus', an: 'Epictetus', id: 45109 },
    { t: 'On the Shortness of Life', a: 'Seneca', an: 'Seneca' },
    { t: 'Thus Spake Zarathustra', a: 'Nietzsche', an: 'Friedrich Nietzsche', id: 1998 },
    { t: 'Beyond Good and Evil', a: 'Nietzsche', an: 'Friedrich Nietzsche', id: 4363 },
    { t: 'Discourse on the Method', a: 'Descartes', an: 'René Descartes', id: 59 },
    { t: 'The Critique of Pure Reason', a: 'Kant', an: 'Immanuel Kant', id: 4280 },
    { t: 'Walden', a: 'Thoreau', an: 'Henry David Thoreau', id: 205 },
    { t: 'Essays, First Series', a: 'Emerson', an: 'Ralph Waldo Emerson' },
    { t: 'An Enquiry Concerning Human Understanding', a: 'Hume', an: 'David Hume', id: 9662 },
    { t: 'Utilitarianism', a: 'Mill', an: 'John Stuart Mill', id: 11224 },
  ],
  'self-improvement': [
    { t: 'The Autobiography of Benjamin Franklin', a: 'Franklin', an: 'Benjamin Franklin', id: 20203 },
    { t: 'Self-Help', a: 'Smiles', an: 'Samuel Smiles' },
    { t: 'Character', a: 'Smiles', an: 'Samuel Smiles' },
    { t: 'As a Man Thinketh', a: 'Allen', an: 'James Allen' },
    { t: 'How to Live on 24 Hours a Day', a: 'Bennett', an: 'Arnold Bennett', id: 2274 },
    { t: 'The Art of Public Speaking', a: 'Esenwein', an: 'Dale Carnegie & J. B. Esenwein', id: 16317 },
    { t: 'Acres of Diamonds', a: 'Conwell', an: 'Russell H. Conwell' },
    { t: 'Etiquette', a: 'Post', an: 'Emily Post' },
    { t: 'Pushing to the Front', a: 'Marden', an: 'Orison Swett Marden' },
    { t: 'The Science of Getting Rich', a: 'Wattles', an: 'Wallace D. Wattles' },
    { t: 'The Power of Concentration', a: 'Dumont', an: 'Theron Q. Dumont' },
    { t: 'The Game of Life and How to Play It', a: 'Shinn', an: 'Florence Scovel Shinn' },
  ],
  'history-biography': [
    { t: 'History of the Decline and Fall of the Roman Empire — Volume 1', a: 'Gibbon', an: 'Edward Gibbon', id: 731 },
    { t: "Plutarch's Lives", a: 'Plutarch', an: 'Plutarch' },
    { t: 'Narrative of the Life of Frederick Douglass, an American Slave', a: 'Douglass', an: 'Frederick Douglass', id: 23 },
    { t: 'Personal Memoirs of U. S. Grant', a: 'Grant', an: 'Ulysses S. Grant' },
    { t: 'The History of Herodotus', a: 'Herodotus', an: 'Herodotus', id: 2707 },
    { t: 'The History of the Peloponnesian War', a: 'Thucydides', an: 'Thucydides', id: 7142 },
    { t: 'The Story of My Life', a: 'Keller', an: 'Helen Keller', id: 2397 },
    { t: 'Autobiography of Benvenuto Cellini', a: 'Cellini', an: 'Benvenuto Cellini', id: 4028 },
    { t: 'Twelve Years a Slave', a: 'Northup', an: 'Solomon Northup', id: 45631 },
    { t: 'Up from Slavery', a: 'Washington', an: 'Booker T. Washington', id: 2376 },
    { t: 'The Diary of Samuel Pepys', a: 'Pepys', an: 'Samuel Pepys' },
    { t: 'Life of Johnson', a: 'Boswell', an: 'James Boswell' },
    { t: 'The Oregon Trail', a: 'Parkman', an: 'Francis Parkman' },
  ],
  'science-nature': [
    { t: 'On the Origin of Species', a: 'Darwin', an: 'Charles Darwin', id: 2009 },
    { t: 'The Voyage of the Beagle', a: 'Darwin', an: 'Charles Darwin', id: 944 },
    { t: 'The Descent of Man', a: 'Darwin', an: 'Charles Darwin' },
    { t: 'The Chemical History of a Candle', a: 'Faraday', an: 'Michael Faraday', id: 14474 },
    { t: 'Relativity: The Special and General Theory', a: 'Einstein', an: 'Albert Einstein' },
    { t: 'The Natural History of Selborne', a: 'White', an: 'Gilbert White' },
    { t: 'The Life of the Spider', a: 'Fabre', an: 'Jean-Henri Fabre' },
    { t: 'The Mountains of California', a: 'Muir', an: 'John Muir' },
    { t: 'The Story of the Heavens', a: 'Ball', an: 'Robert S. Ball' },
    { t: 'The Einstein Theory of Relativity', a: 'Lorentz', an: 'H. A. Lorentz' },
  ],
  'mythology-religion': [
    { t: 'The Age of Fable', a: 'Bulfinch', an: 'Thomas Bulfinch' },
    { t: 'The Age of Chivalry', a: 'Bulfinch', an: 'Thomas Bulfinch' },
    { t: 'The King James Version of the Bible', a: '', an: 'Various', id: 10 },
    { t: 'The Arabian Nights Entertainments', a: 'Lang', an: 'Andrew Lang (ed.)', id: 128 },
    { t: 'Kalevala', a: '', an: 'Elias Lönnrot (comp.)', k: 'poetry' },
    { t: 'The Song of Roland', a: '', an: 'Unknown', k: 'poetry', id: 391 },
    { t: 'The Nibelungenlied', a: '', an: 'Unknown', k: 'poetry', id: 1151 },
    { t: 'Myths of the Norsemen: From the Eddas and Sagas', a: 'Guerber', an: 'H. A. Guerber' },
    { t: "Le Morte d'Arthur", a: 'Malory', an: 'Thomas Malory', id: 1251 },
    { t: 'The Analects of Confucius', a: 'Confucius', an: 'Confucius' },
    { t: 'The Golden Bough: A Study of Magic and Religion', a: 'Frazer', an: 'James George Frazer', id: 3623 },
    { t: 'Gods and Fighting Men', a: 'Gregory', an: 'Lady Gregory' },
  ],
  'essays-letters': [
    { t: 'Essays of Michel de Montaigne', a: 'Montaigne', an: 'Michel de Montaigne', id: 3600 },
    { t: 'Essays', a: 'Bacon', an: 'Francis Bacon', id: 575 },
    { t: 'Essays of Elia', a: 'Lamb', an: 'Charles Lamb' },
    { t: 'Table-Talk', a: 'Hazlitt', an: 'William Hazlitt' },
    { t: 'The Souls of Black Folk', a: 'Du Bois', an: 'W. E. B. Du Bois', id: 408 },
    { t: 'Letters to His Son', a: 'Chesterfield', an: 'Lord Chesterfield' },
    { t: 'Virginibus Puerisque', a: 'Stevenson', an: 'Robert Louis Stevenson' },
    { t: 'Sesame and Lilies', a: 'Ruskin', an: 'John Ruskin' },
    { t: 'Letters of Pliny', a: 'Pliny', an: 'Pliny the Younger' },
    { t: 'Sartor Resartus', a: 'Carlyle', an: 'Thomas Carlyle' },
    { t: 'Confessions of an English Opium-Eater', a: 'De Quincey', an: 'Thomas De Quincey' },
  ],
  'economics-society': [
    { t: 'An Inquiry into the Nature and Causes of the Wealth of Nations', a: 'Smith', an: 'Adam Smith', id: 3300 },
    { t: 'On Liberty', a: 'Mill', an: 'John Stuart Mill', id: 34901 },
    { t: 'The Subjection of Women', a: 'Mill', an: 'John Stuart Mill', id: 27083 },
    { t: 'Democracy in America', a: 'Tocqueville', an: 'Alexis de Tocqueville', id: 815 },
    { t: 'The Prince', a: 'Machiavelli', an: 'Niccolò Machiavelli', id: 1232 },
    { t: 'Leviathan', a: 'Hobbes', an: 'Thomas Hobbes', id: 3207 },
    { t: 'The Social Contract', a: 'Rousseau', an: 'Jean-Jacques Rousseau' },
    { t: 'Utopia', a: 'More', an: 'Thomas More', id: 2130 },
    { t: 'The Theory of the Leisure Class', a: 'Veblen', an: 'Thorstein Veblen', id: 833 },
    { t: 'Common Sense', a: 'Paine', an: 'Thomas Paine', id: 147 },
    { t: 'Rights of Man', a: 'Paine', an: 'Thomas Paine' },
    { t: 'The Federalist Papers', a: '', an: 'Hamilton, Madison, Jay' },
    { t: 'Second Treatise of Government', a: 'Locke', an: 'John Locke', id: 7370 },
  ],
};

// topic= queries used to top a category up to NONFIC_MIN
const NONFIC_TOPICS = {
  psychology: ['psychology', 'psychoanalysis'],
  philosophy: ['philosophy', 'ethics'],
  'self-improvement': ['conduct of life', 'success', 'etiquette'],
  'history-biography': ['biography', 'autobiography', 'history'],
  'science-nature': ['natural history', 'science', 'astronomy'],
  'mythology-religion': ['mythology', 'legends', 'folklore'],
  'essays-letters': ['essays', 'correspondence'],
  'economics-society': ['economics', 'political science', 'sociology'],
};

// Category classifier (one primary category per book).
const CHILD_RE = /juvenile|children|fairy tales|nursery/i;
function classifyCategory(b, kindHint) {
  const tags = [...(b.subjects || []), ...(b.bookshelves || [])].join(' | ');
  if (kindHint === 'play') return 'drama';
  if (kindHint === 'poetry' && !/mytholog|epic|legends|sagas|bible|religion/i.test(tags)) return 'poetry';
  if (FICTION_RE.test(tags)) {
    if (CHILD_RE.test(tags)) return 'children';
    if (/detective|mystery/i.test(tags)) return 'mystery-detective';
    if (/science fiction|fantasy/i.test(tags)) return 'scifi-fantasy';
    if (/horror|ghost|gothic|vampire|supernatural/i.test(tags)) return 'gothic-horror';
    if (/historical fiction/i.test(tags)) return 'historical-fiction';
    if (/humor|humorous|satire/i.test(tags)) return 'humor';
    if (/short stories/i.test(tags)) return 'short-stories';
    if (/love stories/i.test(tags)) return 'romance';
    if (/adventure|sea stories|western stories|pirates/i.test(tags)) return 'adventure';
    if (/\bdramas?\b|\bplays\b|tragedies|comedies/i.test(tags)) return 'drama';
    if (/\bpoetry\b|\bpoems?\b/i.test(tags)) return 'poetry';
    return 'fiction-classics';
  }
  if (/psycholog|psychoanaly/i.test(tags)) return 'psychology';
  if (/mytholog|folklore|legends|sagas|\bbible\b|\beddas?\b|epic/i.test(tags)) return 'mythology-religion';
  if (/philosoph|ethics|stoic/i.test(tags)) return 'philosophy';
  if (/conduct of life|success|self-help|etiquette/i.test(tags)) return 'self-improvement';
  if (/econom|political science|sociolog|social classes|social conditions|commerce|suffrage|liberty/i.test(tags)) return 'economics-society';
  if (/\bessays\b|\bletters\b|correspondence/i.test(tags)) return 'essays-letters';
  if (/natural history|\bscience\b|evolution|astronom|physics|chemistr|botany|zoolog|\bnature\b|biolog|geolog/i.test(tags)) return 'science-nature';
  if (/\bhistory\b|biograph|memoir|antiquities|\bdiaries\b/i.test(tags)) return 'history-biography';
  if (/\bdramas?\b|\bplays\b/i.test(tags)) return 'drama';
  if (/\bpoetry\b|\bpoems?\b/i.test(tags)) return 'poetry';
  return null;
}

// readability veto for non-fiction: books for reading, not reference works
const NONFIC_VETO_RE = /dictionar|encyclop|handbook|manual|textbook|catalog|\bindex\b|periodical|almanac|grammar|primer|phrase book|cook|\btables\b|bibliograph|how to\b|readers\b|\bjournal of\b|\bmagazine\b|\bproceedings\b|\btransactions\b|\bbulletin\b|\breview\b.*\bvolume\b|\bnotes and queries\b|\bsermons?\b|\bhomil|\btracts?\b|\bcensus\b|\breports?\b.*\bsociety\b/i;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleMatchTier(pgTitle, expected) {
  const a = normalize(pgTitle);
  const b = normalize(expected);
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (a.startsWith(b + ' ')) return 2;
  if (a.includes(b) || b.includes(a)) return 1;
  return 0;
}

function slugify(s) {
  return normalize(s).replace(/ /g, '-').replace(/-+/g, '-').slice(0, 60).replace(/^-|-$/g, '') || 'book';
}

let lastRequestAt = 0;
async function politeFetch(url, opts = {}) {
  const wait = lastRequestAt + PAUSE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), opts.timeout || 120000);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(to);
  }
}

async function withRetry(fn, what) {
  let err;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      if (attempt) await sleep(attempt * 2000);
      return await fn();
    } catch (e) {
      err = e;
      log(`  retry ${attempt + 1}/2 for ${what}: ${e.message}`);
    }
  }
  throw new Error(`${what} failed after retries: ${err.message}`);
}

async function apiJSON(url) {
  return withRetry(async () => {
    const res = await politeFetch(url, { timeout: 60000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }, `GET ${url}`);
}

async function downloadEpub(gutenbergId, formats) {
  const candidates = [
    `https://www.gutenberg.org/ebooks/${gutenbergId}.epub.noimages`,
    formats && formats['application/epub+zip'],
    `https://www.gutenberg.org/ebooks/${gutenbergId}.epub3.images`,
  ].filter(Boolean);
  let lastErr = new Error('no epub url');
  for (const url of candidates) {
    try {
      return await withRetry(async () => {
        const res = await politeFetch(url, { timeout: 180000 });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('not a zip (bad magic)');
        return buf;
      }, `download ${url}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader (central directory based; enough for EPUBs)
// ---------------------------------------------------------------------------
function readZipEntries(buf) {
  const maxScan = Math.min(buf.length, 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= buf.length - maxScan; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, uncompSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipEntryData(buf, entry) {
  const p = entry.localOff;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('zip: bad local header');
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const comp = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(comp);
  if (entry.method === 8) return zlib.inflateRawSync(comp);
  throw new Error(`zip: unsupported method ${entry.method}`);
}

// ---------------------------------------------------------------------------
// EPUB validation
// ---------------------------------------------------------------------------
function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i')) || tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m ? m[1] : null;
}

function stripTags(xhtml) {
  return xhtml
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

function validateEpub(buf, { expectedTitles, kind }) {
  let entries;
  try {
    entries = readZipEntries(buf);
  } catch (e) {
    return { ok: false, reason: `zip-broken: ${e.message}` };
  }
  try {
    const mt = entries.get('mimetype');
    if (!mt) return { ok: false, reason: 'mimetype-missing' };
    const mimetype = zipEntryData(buf, mt).toString('utf8').trim();
    if (mimetype !== 'application/epub+zip') return { ok: false, reason: `mimetype-bad: ${mimetype}` };

    const containerEntry = entries.get('META-INF/container.xml');
    if (!containerEntry) return { ok: false, reason: 'container-missing' };
    const container = zipEntryData(buf, containerEntry).toString('utf8');
    const opfPath = attr(container.match(/<rootfile\b[^>]*>/i)?.[0] || '', 'full-path');
    if (!opfPath || !entries.get(opfPath)) return { ok: false, reason: 'opf-missing' };
    const opf = zipEntryData(buf, entries.get(opfPath)).toString('utf8');
    const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

    const opfTitle = (opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] || '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
      .replace(/\s+/g, ' ').trim();
    const languages = [...opf.matchAll(/<dc:language[^>]*>([\s\S]*?)<\/dc:language>/gi)].map((m) => m[1].trim());
    if (!languages.some((l) => /^en/i.test(l))) return { ok: false, reason: `language-bad: ${languages.join(',') || 'none'}` };

    const items = new Map();
    for (const m of opf.matchAll(/<(?:opf:)?item\b[^>]*>/gi)) {
      const id = attr(m[0], 'id');
      if (id) items.set(id, { href: attr(m[0], 'href'), type: attr(m[0], 'media-type') || '' });
    }
    const spineIds = [...opf.matchAll(/<(?:opf:)?itemref\b[^>]*>/gi)].map((m) => attr(m[0], 'idref')).filter(Boolean);
    if (spineIds.length < 3) return { ok: false, reason: `spine-too-short: ${spineIds.length}` };

    let textBytes = 0;
    for (const id of spineIds) {
      const item = items.get(id);
      if (!item || !item.href || !/xhtml|html/i.test(item.type)) continue;
      const href = decodeURIComponent(item.href.split('#')[0]);
      const full = path.posix.normalize(opfDir + href);
      const entry = entries.get(full) || entries.get(href);
      if (!entry) continue;
      try {
        textBytes += Buffer.byteLength(stripTags(zipEntryData(buf, entry).toString('utf8')).trim());
      } catch { /* one bad chapter file -> caught by threshold */ }
    }
    const minText = kind === 'play' || kind === 'poetry' ? VERSE_MIN_TEXT : PROSE_MIN_TEXT;
    if (textBytes < minText) return { ok: false, reason: `text-too-small: ${textBytes} < ${minText}` };

    const titleOk = expectedTitles.some((t) => titleMatchTier(opfTitle, t) > 0 || titleMatchTier(t, opfTitle) > 0);
    if (!titleOk) return { ok: false, reason: `title-mismatch: opf="${opfTitle}" expected="${expectedTitles[0]}"` };

    return { ok: true, spineCount: spineIds.length, textBytes, opfTitle };
  } catch (e) {
    return { ok: false, reason: `epub-parse: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Offline resolution (pg_catalog.csv) — fallback when the Gutendex API is
// down/rate-limited. Downloads of the EPUBs themselves always go directly to
// gutenberg.org either way.
// ---------------------------------------------------------------------------
let OFFLINE_BOOKS = null; // ordered candidate list
let OFFLINE_BY_ID = null;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') {
      row.push(field.replace(/\r$/, ''));
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseCsvAuthor(s) {
  return { name: s.replace(/,?\s*\d{2,4}\??\s*-\s*(\d{2,4}\??)?\s*$/, '').trim() };
}

async function fetchTop100() {
  try {
    const res = await politeFetch('https://www.gutenberg.org/browse/scores/top', { timeout: 60000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const sec = html.split(/Top 100 EBooks last 30 days/i)[1] || html;
    return [...new Set([...sec.matchAll(/\/ebooks\/(\d+)"/g)].map((m) => +m[1]))].slice(0, 100);
  } catch (e) {
    log(`top100 fetch failed (${e.message}) — continuing without it`);
    return [];
  }
}

async function loadOfflineCatalog() {
  const csvPath = path.join(OUT_DIR, 'pg_catalog.csv');
  if (!fs.existsSync(csvPath) || fs.statSync(csvPath).size < 1e6) {
    log('downloading pg_catalog.csv (~20 MB) ...');
    const buf = await withRetry(async () => {
      const res = await politeFetch('https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv', { timeout: 300000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }, 'pg_catalog.csv');
    fs.writeFileSync(csvPath, buf);
  }
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  rows.shift(); // header: Text#,Type,Issued,Title,Language,Authors,Subjects,LoCC,Bookshelves
  const books = [];
  for (const r of rows) {
    if (r.length < 9) continue;
    const [idStr, type, , title, lang, authors, subjects, , shelves] = r;
    const id = +idStr;
    if (!id || type !== 'Text') continue;
    if (!lang.split(/;\s*/).includes('en')) continue;
    books.push({
      id,
      title: title.replace(/\s*\r?\n\s*/g, ' ').trim(),
      authors: authors ? authors.split(/;\s*/).map(parseCsvAuthor) : [],
      subjects: subjects ? subjects.split(/;\s*/) : [],
      bookshelves: shelves ? shelves.split(/;\s*/) : [],
      languages: ['en'],
      media_type: 'Text',
      copyright: false,
      download_count: 0,
      formats: null,
    });
  }
  const top100 = await fetchTop100();
  const topRank = new Map(top100.map((bid, i) => [bid, i]));
  const famous = new Set(
    [...CURATED, ...ALTERNATES, ...Object.values(NONFIC_SEEDS).flat()]
      .map((e) => normalize(e.a))
      .filter(Boolean),
  );
  for (const extra of ['poe', 'wodehouse', 'maupassant', 'henty', 'alger', 'chekhov', 'gogol', 'turgenev', 'ibsen', 'zola', 'scott', 'cooper', 'irving', 'longfellow', 'browning', 'keats', 'byron', 'shelley', 'wordsworth', 'coleridge', 'ovid', 'sophocles', 'euripides', 'aeschylus', 'aristophanes']) {
    famous.add(extra);
  }
  const sortKey = (b) => [
    topRank.has(b.id) ? topRank.get(b.id) : 999,
    b.authors[0] && famous.has(normalize((b.authors[0].name.split(',')[0] || ''))) ? 0 : 1,
    // PG legacy bookshelves (non-"Browsing:") are staff-curated — a quality signal
    b.bookshelves.some((s) => s && !/^Browsing:/.test(s)) ? 0 : 1,
    b.title.toLowerCase(),
  ];
  books.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || (ka[3] < kb[3] ? -1 : ka[3] > kb[3] ? 1 : 0);
  });
  books.forEach((b, i) => { b.download_count = books.length - i; });
  OFFLINE_BOOKS = books;
  OFFLINE_BY_ID = new Map(books.map((b) => [b.id, b]));
  log(`offline catalog ready: ${books.length} English texts, top100 ranked: ${top100.length}`);
}

function resolveOffline(entry) {
  if (entry.id && OFFLINE_BY_ID.has(entry.id)) {
    const hinted = OFFLINE_BY_ID.get(entry.id);
    if (titleMatchTier(hinted.title, entry.t) > 0 || titleMatchTier(entry.t, hinted.title) > 0) return hinted;
  }
  const na = normalize(entry.a);
  let best = null;
  let bestTier = 0;
  for (const b of OFFLINE_BOOKS) {
    if (TITLE_VETO_RE.test(b.title)) continue;
    if (na && !b.authors.some((x) => normalize(x.name).includes(na))) continue;
    const tier = titleMatchTier(b.title, entry.t);
    if (tier > bestTier || (tier === bestTier && tier > 0 && best && b.id < best.id)) {
      best = b;
      bestTier = tier;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Gutendex resolution
// ---------------------------------------------------------------------------
function pickMatch(results, entry) {
  const matches = results
    .filter((b) => b.media_type === 'Text')
    .filter((b) => (b.languages || []).includes('en'))
    .filter((b) => b.id === entry.id || !TITLE_VETO_RE.test(b.title || ''))
    .filter((b) => !entry.a || (b.authors || []).some((au) => normalize(au.name).includes(normalize(entry.a))))
    .map((b) => ({ b, tier: titleMatchTier(b.title, entry.t) }))
    .filter((x) => x.tier > 0);
  if (!matches.length) return null;
  const hinted = entry.id && matches.find((x) => x.b.id === entry.id);
  if (hinted) return hinted.b;
  matches.sort((x, y) => y.tier - x.tier || (y.b.download_count || 0) - (x.b.download_count || 0));
  return matches[0].b;
}

async function resolveCurated(entry) {
  if (OFFLINE_BOOKS) return resolveOffline(entry);
  const q = encodeURIComponent(`${entry.t} ${entry.a}`.trim());
  try {
    const data = await apiJSON(`${API}?search=${q}&languages=en`);
    const hit = pickMatch(data.results || [], entry);
    if (hit) return hit;
  } catch (e) {
    log(`  search failed for "${entry.t}": ${e.message}`);
  }
  if (entry.id) {
    try {
      const b = await apiJSON(`${API}/${entry.id}`);
      if (b && b.id && titleMatchTier(b.title, entry.t) > 0) return b;
    } catch (e) {
      log(`  id fallback failed for "${entry.t}" (#${entry.id}): ${e.message}`);
    }
  }
  return null;
}

// Popular-tier fiction filter
const FICTION_RE = /\bfiction\b|\bdramas?\b|\bpoetry\b|\bpoems?\b|\bplays?\b|fairy tales|\bfolklore\b|\blegends?\b|mytholog|\bepic\b|short stories|\btales?\b|\bcomedies\b|\btragedies\b|\bnovels?\b|nursery rhymes|\bromances\b/i;
const VETO_RE = /erotic|pornograph|periodical|\bmagazines?\b/i;
const VERSE_RE = /\bpoetry\b|\bpoems?\b|\bverse\b|\bdramas?\b|\bplays?\b|\btragedies\b|\bcomedies\b/i;
const TITLE_VETO_RE = /complete works|collected works|\bindex of\b|\banthology\b|table of contents/i;

function isFictionCandidate(b) {
  if (b.media_type !== 'Text') return false;
  if (b.copyright === true) return false;
  if (!(b.languages || []).includes('en')) return false;
  if (TITLE_VETO_RE.test(b.title || '')) return false;
  const tags = [...(b.subjects || []), ...(b.bookshelves || [])].join(' | ');
  if (VETO_RE.test(tags)) return false;
  return FICTION_RE.test(tags);
}

// ---------------------------------------------------------------------------
// State & manifest
// ---------------------------------------------------------------------------
const statePath = path.join(OUT_DIR, 'state.json');
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { done: [], rejected: [], curatedMisses: [] };
  }
}
function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
}

function dupKeyOf(title, author) {
  // author token order varies between sources ("Adam Smith" vs "Smith, Adam")
  const a = normalize(author).split(' ').filter(Boolean).sort().join(' ');
  return `${normalize(title)}::${a}`;
}

async function acquireBook(state, ctx, meta) {
  // meta: { gutenbergId, expectedTitles, kind, tier, title, author, downloadCount, bookshelves, subjects, formats }
  if (ctx.ids.has(meta.gutenbergId)) return null;
  const dupKey = dupKeyOf(meta.title, meta.author);
  if (ctx.dupKeys.has(dupKey)) return null;

  let buf;
  try {
    buf = await downloadEpub(meta.gutenbergId, meta.formats);
  } catch (e) {
    state.rejected.push({ id: meta.gutenbergId, title: meta.title, tier: meta.tier, reason: `download: ${e.message}` });
    saveState(state);
    return null;
  }
  const v = validateEpub(buf, { expectedTitles: meta.expectedTitles, kind: meta.kind });
  if (!v.ok) {
    state.rejected.push({ id: meta.gutenbergId, title: meta.title, tier: meta.tier, reason: v.reason });
    saveState(state);
    log(`  REJECT #${meta.gutenbergId} "${meta.title}" — ${v.reason}`);
    return null;
  }
  let slug = slugify(meta.slugBase || meta.title.split(/[:;]/)[0]);
  if (ctx.slugs.has(slug)) slug = `${slug}-${meta.gutenbergId}`;
  ctx.slugs.add(slug);
  const file = `${slug}.epub`;
  fs.writeFileSync(path.join(OUT_DIR, file), buf);
  const rec = {
    tier: meta.tier,
    category: meta.category || 'fiction-classics',
    slug,
    title: meta.title,
    author: meta.author,
    gutenbergId: meta.gutenbergId,
    file,
    bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    spineCount: v.spineCount,
    textBytes: v.textBytes,
    downloadCount: meta.downloadCount || null,
    bookshelves: meta.bookshelves || [],
  };
  state.done.push(rec);
  ctx.ids.add(meta.gutenbergId);
  ctx.dupKeys.add(dupKey);
  saveState(state);
  return rec;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const state = loadState();
  if (process.env.NARRA_OFFLINE) {
    await loadOfflineCatalog();
    // retry seeds that "failed" only because the Gutendex API was down
    const before = state.rejected.length;
    state.rejected = state.rejected.filter((r) => r.reason !== 'seed-not-found');
    if (state.rejected.length !== before) {
      log(`cleared ${before - state.rejected.length} seed-not-found rejects for offline retry`);
      saveState(state);
    }
  }
  const ctx = { ids: new Set(), dupKeys: new Set(), slugs: new Set() };
  for (const r of state.done) {
    ctx.ids.add(r.gutenbergId);
    ctx.dupKeys.add(dupKeyOf(r.title, r.author));
    ctx.slugs.add(r.slug);
    if (!fs.existsSync(path.join(OUT_DIR, r.file))) {
      log(`state says done but file missing: ${r.file} — will not re-add automatically`);
    }
  }
  const curatedList = CURATED.slice(0, CURATED_LIMIT);
  if (!process.env.NARRA_CURATED_LIMIT && CURATED.length !== 150) {
    throw new Error(`CURATED list must have exactly 150 entries, has ${CURATED.length}`);
  }

  // ---- Phase 1: curated ----
  const curatedAuthorCount = new Map();
  for (const r of state.done.filter((d) => d.tier === 'curated')) {
    curatedAuthorCount.set(r.author, (curatedAuthorCount.get(r.author) || 0) + 1);
  }
  let curatedDone = state.done.filter((d) => d.tier === 'curated').length;
  const doneTitles = new Set(state.done.filter((d) => d.tier === 'curated').map((d) => normalize(d.expectedTitle || d.title)));
  const queue = [...curatedList];
  const altQueue = [...ALTERNATES];

  while (curatedDone < curatedList.length && queue.length) {
    const entry = queue.shift();
    if (state.curatedMisses.some((m) => m.title === entry.t) ||
        state.done.some((d) => d.tier === 'curated' && titleMatchTier(d.title, entry.t) > 0 && d.author === entry.an)) {
      continue;
    }
    log(`[curated ${curatedDone + 1}/${curatedList.length}] ${entry.t} — ${entry.an}`);
    const resolved = await resolveCurated(entry);
    let rec = null;
    if (!resolved) {
      log(`  NOT FOUND on Gutendex: "${entry.t}" (${entry.an})`);
      state.curatedMisses.push({ title: entry.t, author: entry.an, reason: 'not-found-on-gutendex' });
      saveState(state);
    } else {
      rec = await acquireBook(state, ctx, {
        gutenbergId: resolved.id,
        expectedTitles: [entry.t, resolved.title],
        kind: entry.k || 'prose',
        tier: 'curated',
        category: classifyCategory(resolved, entry.k) || 'fiction-classics',
        title: resolved.title,
        author: entry.an,
        slugBase: entry.t,
        downloadCount: resolved.download_count,
        bookshelves: resolved.bookshelves,
        formats: resolved.formats,
      });
    }
    if (rec) {
      curatedDone++;
      curatedAuthorCount.set(entry.an, (curatedAuthorCount.get(entry.an) || 0) + 1);
    } else {
      // pull first alternate whose author is under the curated cap
      let alt = null;
      while (altQueue.length) {
        const cand = altQueue.shift();
        if ((curatedAuthorCount.get(cand.an) || 0) < CURATED_AUTHOR_CAP && !doneTitles.has(normalize(cand.t))) { alt = cand; break; }
      }
      if (alt) {
        log(`  -> substituting with alternate: ${alt.t} — ${alt.an}`);
        state.curatedMisses.push({ title: entry.t, author: entry.an, reason: resolved ? 'validation-failed' : 'not-found-on-gutendex', replacedBy: alt.t });
        saveState(state);
        queue.unshift(alt);
      } else {
        log(`  !! no alternates left, curated set will be short`);
      }
    }
  }
  log(`Curated phase complete: ${curatedDone}/${curatedList.length}`);

  // ---- Phase 2: non-fiction shelves (min NONFIC_MIN per category) ----
  const catCount = () => {
    const m = new Map();
    for (const r of state.done) m.set(r.category, (m.get(r.category) || 0) + 1);
    return m;
  };
  if (TOTAL_TARGET >= 400 || process.env.NARRA_FORCE_NONFIC) {
    for (const [cat, seeds] of Object.entries(NONFIC_SEEDS)) {
      let have = catCount().get(cat) || 0;
      log(`[nonfic] ${cat}: have ${have}, target ${NONFIC_MIN}`);
      const seedList = seeds.slice(0, +(process.env.NARRA_SEED_LIMIT || seeds.length));
      for (const seed of seedList) {
        if (state.done.length >= TOTAL_TARGET) break;
        if (state.rejected.some((r) => r.seed === `${cat}:${seed.t}`)) continue;
        if (state.done.some((d) => d.category === cat && titleMatchTier(d.title, seed.t) > 1)) continue;
        const resolved = await resolveCurated(seed);
        if (!resolved) {
          log(`  seed not found: "${seed.t}" (${seed.an})`);
          state.rejected.push({ id: null, title: seed.t, tier: 'popular', seed: `${cat}:${seed.t}`, reason: 'seed-not-found' });
          saveState(state);
          continue;
        }
        const tags = [...(resolved.subjects || []), ...(resolved.bookshelves || [])].join(' | ');
        if (NONFIC_VETO_RE.test(`${resolved.title} | ${tags}`)) {
          log(`  seed vetoed as reference work: "${resolved.title}"`);
          continue;
        }
        const rec = await acquireBook(state, ctx, {
          gutenbergId: resolved.id,
          expectedTitles: [seed.t, resolved.title],
          kind: seed.k || 'prose',
          tier: 'popular',
          category: cat,
          title: resolved.title,
          author: seed.an,
          slugBase: seed.t,
          downloadCount: resolved.download_count,
          bookshelves: resolved.bookshelves,
          formats: resolved.formats,
        });
        if (rec) log(`  + seed #${resolved.id} ${resolved.title}`);
      }
      // top up: offline candidates or topic queries, most popular first
      have = catCount().get(cat) || 0;
      if (OFFLINE_BOOKS) {
        for (const b of OFFLINE_BOOKS) {
          if (have >= NONFIC_MIN || state.done.length >= TOTAL_TARGET) break;
          if (ctx.ids.has(b.id)) continue;
          if (TITLE_VETO_RE.test(b.title)) continue;
          const tags = [...b.subjects, ...b.bookshelves].join(' | ');
          if (VETO_RE.test(tags) || NONFIC_VETO_RE.test(`${b.title} | ${tags}`)) continue;
          if (FICTION_RE.test(tags)) continue;
          if (classifyCategory(b) !== cat) continue;
          const author = (b.authors[0] && b.authors[0].name) || 'Unknown';
          const rec = await acquireBook(state, ctx, {
            gutenbergId: b.id,
            expectedTitles: [b.title],
            kind: VERSE_RE.test(tags) ? 'poetry' : 'prose',
            tier: 'popular',
            category: cat,
            title: b.title,
            author,
            downloadCount: b.download_count,
            bookshelves: b.bookshelves,
            formats: b.formats,
          });
          if (rec) { have++; log(`  + offline(${cat}) #${b.id} ${b.title} [${have}/${NONFIC_MIN}]`); }
        }
      }
      for (const topic of OFFLINE_BOOKS ? [] : NONFIC_TOPICS[cat]) {
        if (have >= NONFIC_MIN || state.done.length >= TOTAL_TARGET) break;
        let url = `${API}?languages=en&copyright=false&sort=popular&topic=${encodeURIComponent(topic)}`;
        for (let p = 0; p < 8 && have < NONFIC_MIN && url; p++) {
          let data;
          try { data = await apiJSON(url); } catch (e) { log(`  topic "${topic}" page failed: ${e.message}`); break; }
          for (const b of data.results || []) {
            if (have >= NONFIC_MIN || state.done.length >= TOTAL_TARGET) break;
            if (ctx.ids.has(b.id) || b.media_type !== 'Text' || b.copyright === true) continue;
            if (!(b.languages || []).includes('en')) continue;
            if (TITLE_VETO_RE.test(b.title || '')) continue;
            const tags = [...(b.subjects || []), ...(b.bookshelves || [])].join(' | ');
            if (VETO_RE.test(tags) || NONFIC_VETO_RE.test(`${b.title} | ${tags}`)) continue;
            if (FICTION_RE.test(tags)) continue; // fiction goes through the popular phase
            if (classifyCategory(b) !== cat) continue;
            const author = (b.authors && b.authors[0] && b.authors[0].name) || 'Unknown';
            const rec = await acquireBook(state, ctx, {
              gutenbergId: b.id,
              expectedTitles: [b.title],
              kind: VERSE_RE.test(tags) ? 'poetry' : 'prose',
              tier: 'popular',
              category: cat,
              title: b.title,
              author,
              downloadCount: b.download_count,
              bookshelves: b.bookshelves,
              formats: b.formats,
            });
            if (rec) { have++; log(`  + topic(${topic}) #${b.id} ${b.title} [${have}/${NONFIC_MIN}]`); }
          }
          url = data.next;
        }
      }
      log(`[nonfic] ${cat}: now ${catCount().get(cat) || 0}`);
    }
  }

  // ---- Phase 3: popular fill ----
  const popularAuthorCount = new Map();
  for (const r of state.done.filter((d) => d.tier === 'popular')) {
    const k = r.author;
    popularAuthorCount.set(k, (popularAuthorCount.get(k) || 0) + 1);
  }
  let total = state.done.length;
  let page = 1;
  while (total < TOTAL_TARGET && page <= MAX_POPULAR_PAGES) {
    let data;
    if (OFFLINE_BOOKS) {
      if (page > 1) break; // single pass over the offline list
      data = { results: OFFLINE_BOOKS, next: null };
    } else {
      try {
        data = await apiJSON(`${API}?languages=en&copyright=false&sort=popular&page=${page}`);
      } catch (e) {
        log(`popular page ${page} failed permanently: ${e.message}`);
        break;
      }
    }
    for (const b of data.results || []) {
      if (total >= TOTAL_TARGET) break;
      if (ctx.ids.has(b.id)) continue;
      const tags = [...(b.subjects || []), ...(b.bookshelves || [])].join(' | ');
      let category = null;
      if (isFictionCandidate(b)) {
        category = classifyCategory(b);
      } else if (
        b.media_type === 'Text' && b.copyright !== true &&
        (b.languages || []).includes('en') &&
        !TITLE_VETO_RE.test(b.title || '') && !VETO_RE.test(tags) &&
        !FICTION_RE.test(tags) && !NONFIC_VETO_RE.test(`${b.title} | ${tags}`)
      ) {
        category = classifyCategory(b); // readable non-fiction joins its shelf
      }
      if (!category) continue;
      const author = (b.authors && b.authors[0] && b.authors[0].name) || 'Unknown';
      if ((popularAuthorCount.get(author) || 0) >= POPULAR_AUTHOR_CAP) continue;
      const kind = VERSE_RE.test(tags) && !/\bfiction\b/i.test(tags) ? 'poetry' : 'prose';
      const rec = await acquireBook(state, ctx, {
        gutenbergId: b.id,
        expectedTitles: [b.title],
        kind,
        tier: 'popular',
        category,
        title: b.title,
        author,
        downloadCount: b.download_count,
        bookshelves: b.bookshelves,
        formats: b.formats,
      });
      if (rec) {
        total++;
        popularAuthorCount.set(author, (popularAuthorCount.get(author) || 0) + 1);
        if (total % 25 === 0) log(`progress: ${total}/${TOTAL_TARGET} valid books`);
      }
    }
    if (!data.next) { log('gutendex popular listing exhausted'); break; }
    page++;
  }

  // ---- Phase 3: manifest, README, summary ----
  const curated = state.done.filter((d) => d.tier === 'curated');
  const popular = state.done.filter((d) => d.tier === 'popular')
    .sort((a, b2) => (b2.downloadCount || 0) - (a.downloadCount || 0));
  const ordered = [...curated, ...popular].map((r, i) => {
    const { bookshelves, ...rest } = r;
    return { priority: i + 1, ...rest };
  });
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(ordered, null, 1));

  const totalBytes = ordered.reduce((s, r) => s + r.bytes, 0);
  const shelfCounts = {};
  for (const r of popular) for (const s of r.bookshelves || []) {
    const k = s.replace(/^Browsing: /, '');
    shelfCounts[k] = (shelfCounts[k] || 0) + 1;
  }
  const categoryTable = {};
  for (const r of ordered) categoryTable[r.category] = (categoryTable[r.category] || 0) + 1;
  const summary = {
    generatedAt: new Date().toISOString(),
    total: ordered.length,
    curated: curated.length,
    popular: popular.length,
    categoryTable: Object.fromEntries(Object.entries(categoryTable).sort((a, b2) => b2[1] - a[1])),
    totalBytes,
    minBook: ordered.reduce((m, r) => (r.bytes < m.bytes ? r : m), ordered[0]),
    maxBook: ordered.reduce((m, r) => (r.bytes > m.bytes ? r : m), ordered[0]),
    curatedMisses: state.curatedMisses,
    rejectedCount: state.rejected.length,
    rejected: state.rejected,
    popularTop20: popular.slice(0, 20).map((r) => ({ title: r.title, author: r.author, id: r.gutenbergId, downloads: r.downloadCount })),
    bookshelfDistribution: Object.fromEntries(Object.entries(shelfCounts).sort((a, b2) => b2[1] - a[1])),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 1));

  fs.writeFileSync(path.join(OUT_DIR, 'README.md'), `# Narra English Preload Catalog

${ordered.length} public-domain ebooks fetched from Project Gutenberg (via the Gutendex API,
https://gutendex.com) on ${new Date().toISOString().slice(0, 10)}.

- Tier "curated" (priority 1-${curated.length}): product-owner core list + editorial classics.
- Tier "popular": most-downloaded English books on Project Gutenberg, arranged
  into bookstore-style categories (see the "category" field in manifest.json);
  non-fiction shelves (psychology, philosophy, self-improvement,
  history-biography, science-nature, mythology-religion, essays-letters,
  economics-society) are guaranteed at least ${NONFIC_MIN} titles each.
- Format: EPUB (no-images variant preferred). See manifest.json for per-book
  metadata (sha256, sizes, spine/text stats) and summary.json for build stats.

## License

The texts are in the US public domain. They are distributed by Project
Gutenberg under the Project Gutenberg License (https://www.gutenberg.org/policy/license.html).

IMPORTANT for commercial use: "Project Gutenberg" is a registered trademark.
The License permits commercial redistribution only if all references to
Project Gutenberg are removed (headers/footers inside each book and in
metadata) or if trademark royalties are paid. Before shipping these files in a
paid product, strip the Project Gutenberg header/footer boilerplate from each
EPUB. This catalog build intentionally keeps the files byte-identical to the
originals; de-branding is a separate later step.
`);

  log(`DONE: ${ordered.length} books, ${(totalBytes / 1048576).toFixed(1)} MiB, rejected ${state.rejected.length}, curated misses ${state.curatedMisses.length}`);
  if (ordered.length !== TOTAL_TARGET) {
    log(`WARNING: expected ${TOTAL_TARGET}, got ${ordered.length}`);
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
